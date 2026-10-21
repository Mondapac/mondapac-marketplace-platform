import { Logger } from '@nestjs/common';
import { Temporal, err } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeClaimEvaluator,
  FixedFactsClaimQueryBuilder,
  activeTagState,
  allowedDecision,
  refusedDecision,
} from '../../../../../test/support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_BADGE_OFFERS } from '../../contracts/catalog.facade';
import { Offer, type OfferState } from '../../domain/offer';
import type { OfferTagState, TagBadge, TagDecision } from '../../domain/offer-tag';
import { CatalogFacadeImplementation } from '../../presentation/catalog.facade';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import { OfferBadgesQuery } from './offer-badges.use-case';

// `catalog.offer-badges`: the badge of an Offer is built ONLY from a live `evaluateClaims`
// decision, for a published and listed Offer whose stored tag is `active`. Both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');

/** Every key a view may have: pinned, so a new field is a decision and not an accident. */
const VIEW_KEYS = [
  'basis',
  'issuerName',
  'sellerClaim',
  'typeCode',
  'typeName',
  'validUntilLocalDate',
  'verifiedWithIssuer',
];

describe.each([
  ['AU', 'halal'],
  ['ZZ', 'zz-cert'],
] as const)('catalog.offer-badges in market %s', (code, typeCode) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const gate = createUseCaseGate(markets, null);
  const certificate = {
    certificateId: ids.next(),
    versionId: ids.next(),
    typeRevisionId: ids.next(),
  };
  const productId = ids.next<'Product'>();
  const revisionId = ids.next<'ProductRevision'>();
  const variantA = ids.next<'Variant'>();
  const variantB = ids.next<'Variant'>();

  const offerState = (over: Partial<OfferState> = {}): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
    sellerId: ids.next<'Seller'>(),
    productId,
    sellerSku: 'SKU-1',
    conditionCode: 'new',
    description: {},
    handling: 'SEALED_ORIGINAL',
    attestationRecordedAt: null,
    attestationAccountId: null,
    status: 'published',
    offSaleCauses: [],
    listed: true,
    submittedAt: T0,
    firstPublishedAt: T0,
    deletedAt: null,
    version: 3,
    createdAt: T0,
    ...over,
  });

  const units: { options: UnitOfWorkOptions | undefined }[] = [];
  let insideUnit = false;
  let askedInsideUnit = false;
  const unitOfWork = {
    run: async <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) => {
      units.push({ options });
      insideUnit = true;
      try {
        return await work();
      } finally {
        insideUnit = false;
      }
    },
  } as unknown as UnitOfWork;

  let stored = new Map<string, Offer>();
  const offers = {
    findManyByIds: (_m: MarketContext, wanted: readonly Id<'Offer'>[]) =>
      Promise.resolve(wanted.flatMap((id) => (stored.has(id) ? [stored.get(id)!] : []))),
  } as unknown as OfferRepository;

  const policy = {
    locales: () => ({ default: `${code.toLowerCase()}-default`, supported: [] }),
  } as unknown as CatalogMarketPolicy;

  const facts = {
    productId,
    productRevisionId: revisionId,
    revisionPublished: true,
    variantIds: [variantA, variantB],
    platformCategoryPaths: [],
  };
  let claims: FixedFactsClaimQueryBuilder;
  let evaluator: FakeClaimEvaluator;

  const liveBadge =
    (overrides: Partial<TagBadge> = {}) =>
    (decision: TagDecision) => ({
      ...decision,
      badge: { ...decision.badge!, ...overrides },
    });

  function add(state: OfferState, tags: readonly OfferTagState[]): Id<'Offer'> {
    stored.set(state.id, Offer.restore(state, tags));
    return state.id;
  }
  const activeTag = (over: Partial<OfferTagState> = {}, type: string = typeCode) =>
    activeTagState(ids.next<'OfferTag'>(), type, certificate, T0, over);

  const facade = () =>
    new CatalogFacadeImplementation({
      offerBadges: new OfferBadgesQuery(gate, { unitOfWork, offers, claims, evaluator, policy }),
    } as never);
  const ask = (offerIds: readonly Id<'Offer'>[], context?: CallContext) =>
    facade().offerBadges(
      context ?? testCallContext(market, 'anonymous', 'offer-badges-0001'),
      offerIds,
    );
  let warnings: Record<string, unknown>[] = [];
  const hiddenLogs = () => warnings.filter((w) => w.msg === 'catalog.offer-badges.hidden');

  beforeEach(() => {
    warnings = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(message as Record<string, unknown>);
    });
    units.length = 0;
    insideUnit = false;
    askedInsideUnit = false;
    stored = new Map();
    claims = new FixedFactsClaimQueryBuilder(facts);
    evaluator = new FakeClaimEvaluator((query) => allowedDecision(query, certificate), [typeCode]);
    const evaluate = evaluator.evaluate.bind(evaluator);
    evaluator.evaluate = (...args) => {
      askedInsideUnit ||= insideUnit;
      return evaluate(...args);
    };
    evaluator.names.set(typeCode, { typeRevisionId: certificate.typeRevisionId, name: 'Halal' });
  });

  afterEach(() => jest.restoreAllMocks());

  it('declares an anonymous rule under its own name', () => {
    expect(OfferBadgesQuery.access).toEqual({
      name: 'catalog.offer-badges',
      rule: { kind: 'anonymous' },
    });
  });

  it('answers the live badge of an active tag, asked outside any unit, with the type name', async () => {
    const offerId = add(offerState(), [activeTag()]);
    const result = await ask([offerId]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.get(offerId)).toEqual([
      {
        typeCode,
        typeName: 'Halal',
        basis: 'SELLER',
        sellerClaim: true,
        issuerName: null,
        validUntilLocalDate: null,
        verifiedWithIssuer: false,
      },
    ]);
    expect(units).toEqual([{ options: { readOnly: true } }]);
    expect(askedInsideUnit).toBe(false);
    // One query per variant, one call for the page; the name in the Market's default locale.
    expect(evaluator.calls).toHaveLength(1);
    expect(evaluator.calls[0]!.map((q) => q.variantId)).toEqual([variantA, variantB]);
    expect(evaluator.nameLocales).toEqual([`${code.toLowerCase()}-default`]);
  });

  it('copies the live badge, not the stored one (issuer and expiry come from the decision)', async () => {
    const offerId = add(offerState(), [activeTag()]);
    const issuer = { id: ids.next(), displayName: 'Issuer Council' };
    evaluator.decide = (query) =>
      liveBadge({
        sellerClaim: false,
        issuer,
        validUntilLocalDate: '2027-03-01',
        validUntilZone: 'Australia/Brisbane',
        verifiedWithIssuer: true,
      })(allowedDecision(query, certificate));
    const result = await ask([offerId]);
    expect(result.ok && result.value.get(offerId)).toEqual([
      {
        typeCode,
        typeName: 'Halal',
        basis: 'SELLER',
        sellerClaim: false,
        issuerName: 'Issuer Council',
        validUntilLocalDate: '2027-03-01',
        verifiedWithIssuer: true,
      },
    ]);
  });

  it('carries only the allow-listed keys and none of the certificate data', async () => {
    const offerId = add(offerState(), [activeTag()]);
    const result = await ask([offerId]);
    if (!result.ok) throw new Error('expected ok');
    const view = result.value.get(offerId)![0]!;
    expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
    const text = JSON.stringify([...result.value]);
    for (const secret of [
      certificate.certificateId,
      certificate.versionId,
      certificate.typeRevisionId,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('answers no badge when the live decision refuses, though the stored tag is active', async () => {
    const offerId = add(offerState(), [activeTag()]);
    evaluator.decide = (query) => refusedDecision(query, 'no-valid-certificate');
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
  });

  it('answers no badge when one variant is refused', async () => {
    const offerId = add(offerState(), [activeTag()]);
    evaluator.decide = (query) =>
      query.variantId === variantB
        ? refusedDecision(query, 'not-covered')
        : allowedDecision(query, certificate);
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
  });

  it.each(['rechecking', 'suspended', 'pending-publish', 'removed'] as const)(
    'answers no badge for a %s tag even though the live answer allows it',
    async (status) => {
      const offerId = add(offerState(), [activeTag({ status })]);
      const result = await ask([offerId]);
      expect(result.ok && result.value.size).toBe(0);
      expect(evaluator.calls).toEqual([]);
    },
  );

  it('answers no badge for a type with no stored tag', async () => {
    const offerId = add(offerState(), []);
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
    expect(evaluator.calls).toEqual([]);
  });

  it('answers no badge when the live basis differs from the stored tag basis, and logs the code only', async () => {
    const base = activeTag();
    const offerId = add(offerState(), [
      { ...base, copy: { ...base.copy!, basis: 'MANUFACTURER' } },
    ]);
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
    expect(hiddenLogs()).toEqual([
      {
        msg: 'catalog.offer-badges.hidden',
        reason: 'basis-mismatch',
        typeCode,
        marketId: code,
        correlationId: 'offer-badges-0001',
      },
    ]);
  });

  it('answers a MANUFACTURER badge when the stored and live basis are both MANUFACTURER', async () => {
    const base = activeTag();
    const offerId = add(offerState({ attestationRecordedAt: T0 }), [
      {
        ...base,
        copy: { ...base.copy!, basis: 'MANUFACTURER', certificateKind: 'manufacturer' },
      },
    ]);
    evaluator.decide = (query) => {
      const decision = allowedDecision(query, certificate);
      return {
        ...decision,
        basis: 'MANUFACTURER',
        certificate: { ...decision.certificate!, kind: 'manufacturer' },
        badge: { ...decision.badge!, basis: 'MANUFACTURER', sellerClaim: false },
      };
    };
    const result = await ask([offerId]);
    expect(result.ok && result.value.get(offerId)).toEqual([
      {
        typeCode,
        typeName: 'Halal',
        basis: 'MANUFACTURER',
        sellerClaim: false,
        issuerName: null,
        validUntilLocalDate: null,
        verifiedWithIssuer: false,
      },
    ]);
    expect(evaluator.calls[0]!.every((q) => q.handling === 'SEALED_ORIGINAL')).toBe(true);
    expect(evaluator.calls[0]!.every((q) => q.attestationRecorded)).toBe(true);
    expect(hiddenLogs()).toEqual([]);
  });

  it('answers a seller-claim badge with no issuer and no expiry as null name and null date', async () => {
    const offerId = add(offerState(), [activeTag()]);
    const result = await ask([offerId]);
    const badge = result.ok ? result.value.get(offerId)![0]! : null;
    expect(badge).toMatchObject({ sellerClaim: true, issuerName: null, validUntilLocalDate: null });
  });

  it("hands the evaluator one context, the gate's anonymous one of the same Market and correlation id, for a customer caller", async () => {
    const offerId = add(offerState(), [activeTag()]);
    const actor = testAuthenticatedActor(market, {
      population: 'customer',
      accountId: ids.next(),
      sessionId: ids.next(),
      sellerId: null,
    });
    const context = testCallContext(market, actor, 'offer-badges-0002');
    const result = await ask([offerId], context);
    expect(result.ok && result.value.size).toBe(1);
    // The `anonymous` rule runs the use case as the Market's anonymous actor (no customer identity
    // reaches certification); the same context object is used for the ask and the type names.
    expect(evaluator.contexts).toHaveLength(1);
    expect(evaluator.contexts[0]!.actor).toEqual({ kind: 'anonymous', marketId: code });
    expect(evaluator.contexts[0]!.market).toBe(context.market);
    expect(evaluator.contexts[0]!.correlationId).toBe(context.correlationId);
    expect(evaluator.nameContexts[0]).toBe(evaluator.contexts[0]);
  });

  it('answers no badge when the live decisions disagree between variants', async () => {
    const offerId = add(offerState(), [activeTag()]);
    evaluator.decide = (query) =>
      query.variantId === variantB
        ? liveBadge({ verifiedWithIssuer: true })(allowedDecision(query, certificate))
        : allowedDecision(query, certificate);
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
  });

  it('answers no badge when the decision echoes other inputs', async () => {
    const offerId = add(offerState(), [activeTag()]);
    evaluator.decide = (query) =>
      allowedDecision(query, certificate, {
        inputs: { ...query, attestationRecorded: !query.attestationRecorded },
      });
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
  });

  it.each([
    ['not published', { status: 'draft' as const, listed: false }],
    ['off sale', { listed: false, offSaleCauses: ['product-not-listed' as never] }],
    ['without handling', { handling: null }],
  ])('answers no badge for an Offer %s and asks nothing', async (_name, over) => {
    const offerId = add(offerState(over), [activeTag()]);
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
    expect(evaluator.calls).toEqual([]);
  });

  it('answers no badge when the product has no published revision', async () => {
    claims.published = null;
    const offerId = add(offerState(), [activeTag()]);
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
    expect(evaluator.calls).toEqual([]);
  });

  it('answers no badge for any Offer when the evaluator is unavailable', async () => {
    const one = add(offerState(), [activeTag()]);
    const two = add(offerState(), [activeTag()]);
    evaluator.unavailable = true;
    const result = await ask([one, two]);
    expect(result.ok && result.value.size).toBe(0);
  });

  it('answers no badge for any Offer when the evaluator throws or the reads fail', async () => {
    const offerId = add(offerState(), [activeTag()]);
    evaluator.evaluate = () => Promise.reject(new Error('boom'));
    const thrown = await ask([offerId]);
    expect(thrown.ok && thrown.value.size).toBe(0);

    evaluator = new FakeClaimEvaluator((q) => allowedDecision(q, certificate), [typeCode]);
    evaluator.names.set(typeCode, { typeRevisionId: certificate.typeRevisionId, name: 'Halal' });
    claims.publishedSnapshot = () => Promise.reject(new Error('category path'));
    const readFailed = await ask([offerId]);
    expect(readFailed.ok && readFailed.value.size).toBe(0);
  });

  it('answers no badge when the type names cannot be read', async () => {
    const offerId = add(offerState(), [activeTag()]);
    evaluator.namesUnavailable = true;
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
  });

  it('drops the badge when the type has no name, and logs the code only', async () => {
    const offerId = add(offerState(), [activeTag()]);
    evaluator.names.clear();
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
    expect(hiddenLogs()).toEqual([
      {
        msg: 'catalog.offer-badges.hidden',
        reason: 'type-name-missing',
        typeCode,
        marketId: code,
        correlationId: 'offer-badges-0001',
      },
    ]);
  });

  it('drops the badge when the name is of another type revision than the badge, and logs it', async () => {
    const offerId = add(offerState(), [activeTag()]);
    // The live badge is decided on `certificate.typeRevisionId`; the names map holds another.
    evaluator.names.set(typeCode, { typeRevisionId: ids.next(), name: 'Halal' });
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
    expect(hiddenLogs()).toEqual([
      {
        msg: 'catalog.offer-badges.hidden',
        reason: 'type-revision-mismatch',
        typeCode,
        marketId: code,
        correlationId: 'offer-badges-0001',
      },
    ]);
    expect(JSON.stringify(hiddenLogs())).not.toContain(offerId);
  });

  it('asks and shows only the active type when another type of the Offer is suspended', async () => {
    const other = 'aaa-cert';
    const offerId = add(offerState(), [activeTag(), activeTag({ status: 'suspended' }, other)]);
    evaluator.names.set(other, { typeRevisionId: certificate.typeRevisionId, name: 'Other' });
    const result = await ask([offerId]);
    expect(result.ok && result.value.get(offerId)!.map((b) => b.typeCode)).toEqual([typeCode]);
    expect(new Set(evaluator.calls[0]!.map((q) => q.typeCode))).toEqual(new Set([typeCode]));
  });

  it('answers no badge and asks nothing for an active tag with no copy', async () => {
    const offerId = add(offerState(), [activeTag({ copy: null })]);
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
    expect(evaluator.calls).toEqual([]);
  });

  it('gives no entry for an Offer the store does not return, the others unaffected', async () => {
    const present = add(offerState(), [activeTag()]);
    const missing = ids.next<'Offer'>();
    const result = await ask([missing, present]);
    expect(result.ok && [...result.value.keys()]).toEqual([present]);
  });

  it('gives no entry for a soft-deleted Offer, the others unaffected', async () => {
    const present = add(offerState(), [activeTag()]);
    const deleted = add(offerState({ status: 'deleted', listed: false, deletedAt: T0 }), [
      activeTag(),
    ]);
    const result = await ask([deleted, present]);
    expect(result.ok && [...result.value.keys()]).toEqual([present]);
  });

  it('keeps the badge of one type when another type is refused, in type-code order', async () => {
    const other = 'aaa-cert';
    const offerId = add(offerState(), [activeTag(), activeTag({}, other)]);
    evaluator.names.set(other, { typeRevisionId: certificate.typeRevisionId, name: 'Other' });
    evaluator.decide = (query) =>
      query.typeCode === typeCode
        ? allowedDecision(query, certificate)
        : refusedDecision(query, 'no-valid-certificate');
    const result = await ask([offerId]);
    expect(result.ok && result.value.get(offerId)!.map((b) => b.typeCode)).toEqual([typeCode]);

    evaluator.decide = (query) => allowedDecision(query, certificate);
    const both = await ask([offerId]);
    expect(both.ok && both.value.get(offerId)!.map((b) => b.typeCode)).toEqual([other, typeCode]);
  });

  it('asks the badges of many Offers in one call and keeps them apart', async () => {
    const withTag = add(offerState(), [activeTag()]);
    const without = add(offerState(), []);
    const result = await ask([withTag, without, withTag]);
    expect(result.ok && [...result.value.keys()]).toEqual([withTag]);
    expect(evaluator.calls).toHaveLength(1);
  });

  it('refuses more than the limit of distinct ids, a malformed id and a non-array, before any read', async () => {
    const many = Array.from({ length: MAX_BADGE_OFFERS + 1 }, () => ids.next<'Offer'>());
    for (const input of [many, ['nope' as Id<'Offer'>], 'x' as never]) {
      const result = await ask(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ code: 'validation.failed' });
    }
    expect(units).toEqual([]);
    expect(evaluator.calls).toEqual([]);
  });

  it('accepts exactly the limit, and counts duplicates once', async () => {
    const some = Array.from({ length: MAX_BADGE_OFFERS }, () => ids.next<'Offer'>());
    expect((await ask(some)).ok).toBe(true);
    expect((await ask([...some, some[0]!])).ok).toBe(true);
  });

  it('opens no unit and asks nothing for no ids', async () => {
    const result = await ask([]);
    expect(result.ok && result.value.size).toBe(0);
    expect(units).toEqual([]);
  });

  it('is never reached with a failed unit as a stored answer', async () => {
    const offerId = add(offerState(), [activeTag()]);
    (unitOfWork as unknown as { run: unknown }).run = () => Promise.resolve(err({}));
    const result = await ask([offerId]);
    expect(result.ok && result.value.size).toBe(0);
  });
});
