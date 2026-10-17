import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Offer, type OfferState } from '../../domain/offer';
import type { ClaimFacts, OfferTagState } from '../../domain/offer-tag';
import {
  FakeClaimEvaluator,
  FixedFactsClaimQueryBuilder,
  RecordingOutbox,
  activeTagState,
  allowedDecision,
  refusedDecision,
} from '../../../../../test/support/catalog-tag-fakes';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { OwnOfferRecordAttestation } from './own-offer-record-attestation.use-case';

// `own-offer.record-attestation` in memory (ADR-0012 d4; catalog design 4.4, 5.4, 8.2; Ali B1), on
// both Market fixtures.
// The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-09T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('own-offer.record-attestation in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const condition = realPolicy.conditions(market)[0]!;

  const contextOf = (population: 'admin' | 'seller' | 'customer'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );

  const offerState = (overrides: Partial<OfferState> = {}): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
    sellerId,
    productId: ids.next<'Product'>(),
    sellerSku: 'SKU-1',
    conditionCode: condition,
    description: {},
    handling: null,
    attestationRecordedAt: null,
    attestationAccountId: null,
    status: 'draft',
    offSaleCauses: [],
    listed: false,
    submittedAt: null,
    firstPublishedAt: null,
    deletedAt: null,
    version: 2,
    createdAt: T0,
    ...overrides,
  });

  const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
  const variantIds = [ids.next<'Variant'>()];
  const certificateIds = {
    certificateId: ids.next(),
    versionId: ids.next(),
    typeRevisionId: ids.next(),
  };
  const factsOf = (state: OfferState): ClaimFacts => ({
    productId: state.productId,
    productRevisionId: ids.next<'ProductRevision'>(),
    revisionPublished: true,
    variantIds,
    platformCategoryPaths: [],
  });
  const publishedOffer = () =>
    offerState({
      status: 'published',
      listed: true,
      firstPublishedAt: T0,
      submittedAt: T0,
      handling: 'SEALED_ORIGINAL',
    });

  function rig(
    options: {
      offer?: OfferState | null;
      eligible?: boolean;
      saveThrows?: Error;
      reserve?: { code: 'request.throttled'; retryAfterSeconds: number } | null;
      tags?: OfferTagState[];
      refuseWithoutAttestation?: boolean;
      unavailable?: boolean;
    } = {},
  ) {
    const state = options.offer === undefined ? offerState() : options.offer;
    const evaluator = new FakeClaimEvaluator(
      (query) =>
        options.refuseWithoutAttestation === true && !query.attestationRecorded
          ? refusedDecision(query, 'attestation-missing')
          : allowedDecision(query, certificateIds),
      [typeCode],
    );
    evaluator.unavailable = options.unavailable ?? false;
    const outbox = new RecordingOutbox();
    const claims = new FixedFactsClaimQueryBuilder(state === null ? null : factsOf(state));
    const saved: Offer[] = [];
    const reserved: number[] = [];
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const useCase = new OwnOfferRecordAttestation(gate, {
      unitOfWork,
      offers: {
        add: () => Promise.reject(new Error('unused')),
        listOnProduct: () => Promise.resolve([]),
        listPendingReview: () => Promise.resolve([]),
        findManyByIds: () => Promise.resolve([]),
        findById: () =>
          Promise.resolve(state === null ? null : Offer.restore(state, options.tags ?? [])),
        save: (_m, offer) => {
          if (options.saveThrows !== undefined) return Promise.reject(options.saveThrows);
          saved.push(offer);
          return Promise.resolve(null);
        },
      },
      eligibility: { isEligible: () => Promise.resolve(options.eligible ?? true) },
      save: {
        reserveSaves: () => {
          reserved.push(1);
          return Promise.resolve(options.reserve ?? null);
        },
      },
      claims,
      evaluator,
      outbox,
      clock,
    });
    return { useCase, state, saved, reserved, evaluator, outbox };
  }

  const sealed = (overrides: Partial<OfferState> = {}) =>
    offerState({ handling: 'SEALED_ORIGINAL', ...overrides });
  const attestedPublished = () => ({
    ...publishedOffer(),
    attestationRecordedAt: T0,
    attestationAccountId: ids.next<'Account'>(),
  });

  it('records who attested and when on the actor’s own sealed-original draft', async () => {
    const r = rig({ offer: sealed() });
    const context = contextOf('seller');
    const outcome = await r.useCase.execute(context, { offerId: r.state!.id, attested: true });
    expect(outcome).toEqual({
      ok: true,
      value: { changedFields: ['attestation'], attestationRecordedAt: T0.toString() },
    });
    expect(r.saved[0]!.state).toMatchObject({
      attestationRecordedAt: T0,
      attestationAccountId: context.actor.kind === 'authenticated' ? context.actor.accountId : '',
      version: 3,
      status: 'draft',
    });
    expect(r.saved[0]!.pendingHistory).toMatchObject({
      changeKind: 'attestation-recorded',
      changedFields: ['attestation'],
    });
    expect(r.reserved).toHaveLength(1);
    // No kept tag: nothing to ask.
    expect(r.evaluator.calls).toHaveLength(0);
  });

  it('refuses to record on an Offer whose handling is not SEALED_ORIGINAL, storing nothing', async () => {
    for (const handling of [null, 'REPACKED', 'PREPARED', 'FRESH'] as const) {
      const r = rig({ offer: offerState({ handling }) });
      const outcome = await r.useCase.execute(contextOf('seller'), {
        offerId: r.state!.id,
        attested: true,
      });
      expect(outcome).toEqual({
        ok: false,
        error: { code: 'offer.attestation-needs-sealed-original' },
      });
      expect(r.saved).toHaveLength(0);
      expect(r.evaluator.calls).toHaveLength(0);
    }
  });

  it('stores nothing when the Offer already holds the choice', async () => {
    const r = rig({ offer: sealed() });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      attested: false,
    });
    expect(outcome).toEqual({
      ok: true,
      value: { changedFields: [], attestationRecordedAt: null },
    });
    expect(r.saved[0]!.pendingHistory).toBeNull();
    expect(r.saved[0]!.state.version).toBe(2);
  });

  it('asks every kept tag again with the attestation withdrawn and keeps one still allowed', async () => {
    const offer = attestedPublished();
    const r = rig({
      offer,
      tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0)],
    });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: offer.id,
      attested: false,
    });
    expect(outcome).toEqual({
      ok: true,
      value: { changedFields: ['attestation'], attestationRecordedAt: null },
    });
    expect(r.evaluator.calls).toHaveLength(1);
    expect(r.evaluator.calls[0]!.map((q) => q.attestationRecorded)).toEqual([false]);
    expect(r.saved[0]!.state).toMatchObject({
      status: 'published',
      listed: true,
      attestationRecordedAt: null,
      attestationAccountId: null,
    });
    expect(r.saved[0]!.pendingHistory?.changeKind).toBe('attestation-withdrawn');
    expect(r.saved[0]!.tags[0]!.status).toBe('active');
  });

  it('suspends a tag the withdrawal no longer allows and takes the Offer off sale', async () => {
    const offer = attestedPublished();
    const r = rig({
      offer,
      tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0)],
      refuseWithoutAttestation: true,
    });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: offer.id,
      attested: false,
    });
    expect(outcome.ok).toBe(true);
    expect(r.saved[0]!.tags[0]).toMatchObject({
      status: 'suspended',
      lastReasonCode: 'attestation-missing',
      lastChangeCause: 'attestation-change',
    });
    expect(r.saved[0]!.state.listed).toBe(false);
    expect(r.saved[0]!.state.offSaleCauses).toContain('tag-suspended');
    expect(r.outbox.types).toEqual([
      'catalog.offer-tag-suspended.v1',
      'catalog.offer-listing-changed.v1',
    ]);
  });

  it('restores a tag suspended for a missing attestation when it is recorded', async () => {
    const offer = {
      ...publishedOffer(),
      listed: false,
      offSaleCauses: ['tag-suspended' as const],
    };
    const r = rig({
      offer,
      tags: [
        activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0, {
          status: 'suspended',
          badge: null,
          lastReasonCode: 'attestation-missing',
          changeSeq: 2,
        }),
      ],
      refuseWithoutAttestation: true,
    });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: offer.id,
      attested: true,
    });
    expect(outcome.ok).toBe(true);
    expect(r.evaluator.calls[0]!.map((q) => q.attestationRecorded)).toEqual([true]);
    expect(r.saved[0]!.tags[0]).toMatchObject({
      status: 'active',
      lastChangeCause: 'attestation-change',
    });
    expect(r.saved[0]!.state).toMatchObject({ listed: true, offSaleCauses: [] });
    expect(r.outbox.types).toEqual([
      'catalog.offer-tag-restored.v1',
      'catalog.offer-listing-changed.v1',
    ]);
  });

  it('refuses the change, storing nothing, when the check is unavailable (fail closed)', async () => {
    const offer = attestedPublished();
    const r = rig({
      offer,
      tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0)],
      unavailable: true,
    });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: offer.id,
      attested: false,
    });
    expect(outcome).toEqual({ ok: false, error: { code: 'claim.check-unavailable' } });
    expect(r.saved).toHaveLength(0);
    expect(r.outbox.types).toEqual([]);
  });

  it('answers a byte-identical offer.not-found for an unknown, another seller’s and deleted Offer', async () => {
    const other = ids.next<'Seller'>();
    const cases = [
      rig({ offer: null }),
      rig({ offer: sealed({ sellerId: other }) }),
      rig({ offer: sealed({ status: 'deleted', deletedAt: T0 }) }),
    ];
    const answers: string[] = [];
    for (const r of cases) {
      const id = r.state?.id ?? ids.next<'Offer'>();
      answers.push(
        JSON.stringify(
          await r.useCase.execute(contextOf('seller'), { offerId: id, attested: true }),
        ),
      );
      expect(r.saved).toHaveLength(0);
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(JSON.stringify({ ok: false, error: { code: 'offer.not-found' } }));
  });

  it('refuses a non-boolean choice, an unknown key and a bad id before spending the budget', async () => {
    const r = rig({ offer: sealed() });
    const id = r.state!.id;
    for (const input of [
      { offerId: id, attested: 'true' },
      { offerId: id, attested: 1 },
      { offerId: id, attested: undefined },
      { offerId: id, attested: true, handling: 'SEALED_ORIGINAL' },
      { offerId: id, attested: true, attestationAccountId: ids.next() },
      { offerId: id, attested: true, attestationRecordedAt: T0.toString() },
      { offerId: 'nope', attested: true },
    ]) {
      const outcome = await r.useCase.execute(contextOf('seller'), input);
      expect(outcome).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    }
    expect(r.reserved).toHaveLength(0);
    expect(r.saved).toHaveLength(0);
  });

  it('refuses a non-seller actor, an ineligible seller and a spent budget', async () => {
    const r = rig({ offer: sealed() });
    const input = { offerId: r.state!.id, attested: true };
    for (const population of ['customer', 'admin'] as const) {
      expect(await r.useCase.execute(contextOf(population), input)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    const ineligible = rig({ offer: sealed(), eligible: false });
    expect(
      await ineligible.useCase.execute(contextOf('seller'), {
        ...input,
        offerId: ineligible.state!.id,
      }),
    ).toEqual({ ok: false, error: { code: 'seller.not-eligible' } });
    const throttled = rig({
      offer: sealed(),
      reserve: { code: 'request.throttled', retryAfterSeconds: 7 },
    });
    expect(
      await throttled.useCase.execute(contextOf('seller'), {
        ...input,
        offerId: throttled.state!.id,
      }),
    ).toEqual({ ok: false, error: { code: 'request.throttled', retryAfterSeconds: 7 } });
    expect(throttled.saved).toHaveLength(0);
    expect(r.saved).toHaveLength(0);
  });

  it('asks again after a stale save and answers conflict.retry after the last attempt', async () => {
    const r = rig({ offer: sealed(), saveThrows: new StaleAggregateError('Offer', 'x') });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      attested: true,
    });
    expect(outcome).toEqual({ ok: false, error: { code: 'conflict.retry' } });
  });

  it('refuses an acting-as session before any read (B1; Hassan L1)', async () => {
    const r = rig({ offer: sealed() });
    const context = contextOf('seller');
    const actor = { ...context.actor, actingAs: { adminAccountId: ids.next() } };
    const outcome = await r.useCase.execute(
      { ...context, actor: actor },
      { offerId: r.state!.id, attested: true },
    );
    expect(outcome).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(r.saved).toHaveLength(0);
    expect(r.reserved).toHaveLength(0);
  });
});
