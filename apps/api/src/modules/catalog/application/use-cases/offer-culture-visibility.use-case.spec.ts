import { Logger } from '@nestjs/common';
import { Temporal, err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
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
import { MAX_VISIBILITY_OFFERS } from '../../contracts/catalog-cultures.facade';
import type { CultureState } from '../../domain/culture';
import type { CultureCategoryRow } from '../../domain/culture-category';
import { Offer, type OfferState } from '../../domain/offer';
import type { OfferTagState } from '../../domain/offer-tag';
import { CatalogCulturesFacadeImplementation } from '../../presentation/catalog-cultures.facade';
import type { CultureReader } from '../ports/culture.reader';
import type { CultureRepository } from '../ports/culture.repository';
import type {
  SellerCertificateTypes,
  SellerMemberCultures,
} from '../ports/culture-visibility-sources';
import type { OfferRepository } from '../ports/offer.repository';
import { OfferCultureVisibility } from './offer-culture-visibility.use-case';
import { OfferCultureVisibilitySystem } from './offer-culture-visibility-system.use-case';

// The shared culture filter (multi-culture package 3a; ADR-0047 decisions 5 and 6, ADR-0048 M2)
// through catalog's cultures facade, on both Market fixtures: AU with a halal culture and ZZ with
// a kosher one. Sellers, certification and evaluateClaims are fakes at catalog's ports; the
// domain truth table is `domain/culture-visibility.spec.ts`.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-12T00:00:00Z');

describe.each([
  { code: 'AU', type: 'halal', certified: 'muslim', plain: 'general' },
  { code: 'ZZ', type: 'kosher', certified: 'jewish', plain: 'everyone' },
] as const)('catalog culture visibility in market $code', (fx) => {
  const market: MarketContext = testMarketContext(fx.code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const gate = createUseCaseGate(markets, null);
  const anonymous = testCallContext(market, 'anonymous', 'culture-vis-0001');
  const system = testCallContext(market, 'system', 'culture-vis-0002');
  const certificate = {
    certificateId: ids.next(),
    versionId: ids.next(),
    typeRevisionId: ids.next(),
  };
  const productId = ids.next<'Product'>();
  const root = ids.next<'Category'>();
  const leaf = ids.next<'Category'>();
  const sellerId = ids.next<'Seller'>();

  const culture = (
    code: string,
    displayOrder: number,
    requiredCertificationType: string | null,
  ): CultureState =>
    ({
      id: ids.next<'Culture'>(),
      code,
      status: 'active',
      displayOrder,
      requiredCertificationType,
      badgeColour: null,
      isDefault: false,
      names: [],
      createdBy: null,
      createdAt: T0,
      updatedAt: T0,
      version: 1,
    }) as unknown as CultureState;
  const certifiedCulture = culture(fx.certified, 20, fx.type);
  const plainCulture = culture(fx.plain, 10, null);

  const offerState = (over: Partial<OfferState> = {}): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: fx.code as MarketId,
    sellerId,
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

  let insideUnit = false;
  let askedInsideUnit = false;
  const units: (UnitOfWorkOptions | undefined)[] = [];
  const unitOfWork = {
    run: async <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) => {
      units.push(options);
      insideUnit = true;
      try {
        return await work();
      } finally {
        insideUnit = false;
      }
    },
  } as unknown as UnitOfWork;

  let stored: Map<string, Offer>;
  const offers = {
    findManyByIds: (_m: MarketContext, wanted: readonly Id<'Offer'>[]) =>
      Promise.resolve(wanted.flatMap((id) => (stored.has(id) ? [stored.get(id)!] : []))),
  } as unknown as OfferRepository;
  let activeCultures: CultureState[];
  const cultureReader = {
    list: () => Promise.resolve(activeCultures),
  } as unknown as CultureReader;
  let rows: Map<string, CultureCategoryRow[]>;
  const rowReads: Id<'Culture'>[][] = [];
  const cultures = {
    categoryRowsOf: (_m: MarketContext, ids: readonly Id<'Culture'>[]) => {
      rowReads.push([...ids]);
      return Promise.resolve(new Map(ids.map((id) => [id, rows.get(id) ?? []])));
    },
  } as unknown as CultureRepository;

  let members: Map<Id<'Seller'>, Set<Id<'Culture'>>> | 'down';
  const memberCultures: SellerMemberCultures = {
    approvedCultures: (_c, sellerIds) =>
      Promise.resolve(
        members === 'down'
          ? err({ code: 'culture-visibility.source-unavailable' } as const)
          : ok(
              new Map(
                sellerIds.flatMap((s) =>
                  (members as Map<Id<'Seller'>, Set<Id<'Culture'>>>).has(s)
                    ? [[s, (members as Map<Id<'Seller'>, Set<Id<'Culture'>>>).get(s)!]]
                    : [],
                ),
              ),
            ),
      ),
  };
  let validTypes: Set<string> | 'down';
  const typeAsks: string[][] = [];
  const certificateCalls: Id<'Seller'>[][] = [];
  const certificateTypes: SellerCertificateTypes = {
    validTypes: (_c, sellerIds, typeCodes) => {
      certificateCalls.push([...sellerIds]);
      typeAsks.push([...typeCodes]);
      return Promise.resolve(
        validTypes === 'down'
          ? err({ code: 'culture-visibility.source-unavailable' } as const)
          : ok(
              new Map(
                sellerIds.map((s) => [
                  s,
                  new Set([...(validTypes as Set<string>)].filter((t) => typeCodes.includes(t))),
                ]),
              ),
            ),
      );
    },
  };

  let claims: FixedFactsClaimQueryBuilder;
  let evaluator: FakeClaimEvaluator;
  const facade = () => {
    const deps = {
      unitOfWork,
      offers,
      claims,
      evaluator,
      cultureReader,
      cultures,
      memberCultures,
      certificateTypes,
    };
    return new CatalogCulturesFacadeImplementation({
      visibility: new OfferCultureVisibility(gate, deps),
      visibilitySystem: new OfferCultureVisibilitySystem(gate, deps),
    } as never);
  };
  const add = (state: OfferState, tags: readonly OfferTagState[] = []): Id<'Offer'> => {
    stored.set(state.id, Offer.restore(state, tags));
    return state.id;
  };
  const tag = (type: string = fx.type, over: Partial<OfferTagState> = {}) =>
    activeTagState(ids.next<'OfferTag'>(), type, certificate, T0, over);
  const codesOf = async (offerId: Id<'Offer'>, context: CallContext = anonymous) => {
    const answer = await facade().visibleCultureCodesForOffers(context, [offerId]);
    if (!answer.ok) return answer.error.code;
    return answer.value.get(offerId) ?? 'absent';
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    stored = new Map();
    activeCultures = [certifiedCulture, plainCulture];
    rows = new Map();
    members = new Map([[sellerId, new Set([certifiedCulture.id, plainCulture.id])]]);
    validTypes = new Set([fx.type]);
    certificateCalls.length = 0;
    rowReads.length = 0;
    typeAsks.length = 0;
    units.length = 0;
    insideUnit = false;
    askedInsideUnit = false;
    claims = new FixedFactsClaimQueryBuilder({
      productId,
      productRevisionId: ids.next<'ProductRevision'>(),
      revisionPublished: true,
      variantIds: [ids.next<'Variant'>()],
      platformCategoryPaths: [[root, leaf]],
    });
    evaluator = new FakeClaimEvaluator((query) => allowedDecision(query, certificate), [fx.type]);
    const evaluate = evaluator.evaluate.bind(evaluator);
    evaluator.evaluate = (...args) => {
      askedInsideUnit ||= insideUnit;
      return evaluate(...args);
    };
  });

  afterEach(() => jest.restoreAllMocks());

  it('declares the anonymous / system pair under their own names', () => {
    expect(OfferCultureVisibility.access).toEqual({
      name: 'catalog.offer-culture-visibility',
      rule: { kind: 'anonymous' },
    });
    expect(OfferCultureVisibilitySystem.access).toEqual({
      name: 'catalog.offer-culture-visibility-system',
      rule: { kind: 'system' },
    });
  });

  it('a member with a valid certificate and an allowed tag is visible in both, in display order', async () => {
    const offerId = add(offerState(), [tag()]);

    expect(await codesOf(offerId)).toEqual([fx.plain, fx.certified]);
    // One read-only unit; evaluateClaims asked outside it, as the system actor too.
    expect(units).toEqual([{ readOnly: true }]);
    expect(askedInsideUnit).toBe(false);
    expect(await codesOf(offerId, system)).toEqual([fx.plain, fx.certified]);
  });

  it('a required category without the tag shows the Offer only where membership is enough', async () => {
    const offerId = add(offerState());
    expect(await codesOf(offerId)).toEqual([fx.plain]);
    expect(evaluator.calls).toEqual([]);
  });

  it('a tag of another type is never read as the culture type (no claim is inferred)', async () => {
    const offerId = add(offerState(), [tag(fx.code === 'AU' ? 'kosher' : 'halal')]);
    expect(await codesOf(offerId)).toEqual([fx.plain]);
  });

  it('evaluateClaims refusing the tag now hides the Offer in the certified culture', async () => {
    const offerId = add(offerState(), [tag()]);
    evaluator.decide = (query) => refusedDecision(query, 'certificate-expired');
    expect(await codesOf(offerId)).toEqual([fx.plain]);
  });

  it('a stored tag that is not active counts for nothing', async () => {
    const offerId = add(offerState(), [tag(fx.type, { status: 'suspended' })]);
    expect(await codesOf(offerId)).toEqual([fx.plain]);
  });

  it('a neutral category needs membership only (and a valid certificate, M2)', async () => {
    rows.set(certifiedCulture.id, [
      { categoryId: root, visible: true, certificationMark: 'neutral' },
    ]);
    const offerId = add(offerState());
    expect(await codesOf(offerId)).toEqual([fx.plain, fx.certified]);

    validTypes = new Set();
    expect(await codesOf(offerId)).toEqual([fx.plain]);
  });

  it('an expired, revoked or wrong-type certificate hides the Offer in the certified culture (M2)', async () => {
    const offerId = add(offerState(), [tag()]);
    validTypes = new Set([fx.code === 'AU' ? 'kosher' : 'halal']);
    expect(await codesOf(offerId)).toEqual([fx.plain]);
  });

  it('a branch hidden on an ancestor hides the Offer in that culture only', async () => {
    rows.set(plainCulture.id, [{ categoryId: root, visible: false, certificationMark: null }]);
    const offerId = add(offerState(), [tag()]);
    expect(await codesOf(offerId)).toEqual([fx.certified]);
    // A row lower down cannot show it again, nor can a mark-only row (ADR-0048 M2).
    rows.set(plainCulture.id, [
      { categoryId: root, visible: false, certificationMark: null },
      { categoryId: leaf, visible: true, certificationMark: null },
    ]);
    expect(await codesOf(offerId)).toEqual([fx.certified]);
    rows.set(certifiedCulture.id, [
      { categoryId: root, visible: false, certificationMark: null },
      { categoryId: leaf, visible: null, certificationMark: 'neutral' },
    ]);
    expect(await codesOf(offerId)).toEqual([]);
  });

  it('reads the category rows of every culture in one statement and the products in one batch', async () => {
    const many = Array.from({ length: 30 }, (_, n) =>
      add(offerState({ productId: n % 2 === 0 ? productId : ids.next<'Product'>() }), [tag()]),
    );
    const answer = await facade().visibleCultureCodesForOffers(anonymous, many);
    expect(answer.ok && answer.value.size).toBe(30);
    expect(rowReads).toEqual([[certifiedCulture.id, plainCulture.id]]);
    expect(claims.publishedBatches).toBe(1);
    // Certification is asked only about the types the active cultures require.
    expect(typeAsks).toEqual([[fx.type]]);
    expect(claims.publishedReads).toBe(0);
  });

  it('a seller approved nowhere is visible nowhere; certificates are asked only for certified members', async () => {
    members = new Map([[sellerId, new Set([plainCulture.id])]]);
    const offerId = add(offerState(), [tag()]);
    expect(await codesOf(offerId)).toEqual([fx.plain]);
    expect(certificateCalls).toEqual([]);

    members = new Map();
    expect(await codesOf(offerId)).toEqual([]);
  });

  it('an inactive culture is not listed; an unpublished or unknown Offer is absent', async () => {
    activeCultures = [plainCulture];
    const published = add(offerState(), [tag()]);
    const draft = add(offerState({ status: 'draft' }), [tag()]);
    expect(await codesOf(published)).toEqual([fx.plain]);
    expect(await codesOf(draft)).toBe('absent');
    expect(await codesOf(ids.next<'Offer'>())).toBe('absent');
  });

  it.each([
    ['sellers', () => (members = 'down')],
    ['certification', () => (validTypes = 'down')],
    ['evaluateClaims', () => (evaluator.unavailable = true)],
  ])(
    'fails closed when %s cannot answer: the whole call is unavailable',
    async (_name, breakIt) => {
      const offerId = add(offerState(), [tag()]);
      breakIt();
      expect(await codesOf(offerId)).toBe('culture-visibility.unavailable');
      expect(await facade().isOfferVisibleIn(anonymous, offerId, [fx.plain])).toBe(false);
    },
  );

  it('isOfferVisibleIn: true when one chosen culture shows the Offer; false on an empty or unknown list', async () => {
    const offerId = add(offerState());
    const ask = (codes: readonly string[]) => facade().isOfferVisibleIn(anonymous, offerId, codes);
    expect(await ask([fx.certified, fx.plain])).toBe(true);
    expect(await ask([fx.certified])).toBe(false);
    expect(await ask([])).toBe(false);
    expect(await ask(['unknown'])).toBe(false);
  });

  it('refuses more than the cap, or a malformed id, before any read', async () => {
    const many = Array.from({ length: MAX_VISIBILITY_OFFERS + 1 }, () => ids.next<'Offer'>());
    expect(await facade().visibleCultureCodesForOffers(anonymous, many)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'offerIds', code: 'length' }] },
    });
    expect(await facade().visibleCultureCodesForOffers(anonymous, ['nope' as Id<'Offer'>])).toEqual(
      {
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'offerIds', code: 'format' }] },
      },
    );
    expect(units).toEqual([]);
  });
});
