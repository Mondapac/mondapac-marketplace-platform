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
import { OwnOfferSetHandling } from './own-offer-set-handling.use-case';

// `own-offer.set-handling` in memory (catalog design 4.4, 8.2; Ali B1), on both Market fixtures.
// The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-09T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('own-offer.set-handling in market %s', (code) => {
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
      refuseHandling?: string;
      unavailable?: boolean;
    } = {},
  ) {
    const state = options.offer === undefined ? offerState() : options.offer;
    const evaluator = new FakeClaimEvaluator(
      (query) =>
        options.refuseHandling !== undefined && query.handling === options.refuseHandling
          ? refusedDecision(query, 'handling-not-allowed')
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
    const useCase = new OwnOfferSetHandling(gate, {
      unitOfWork,
      offers: {
        add: () => Promise.reject(new Error('unused')),
        listPendingReview: () => Promise.resolve([]),
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

  it('records the handling on the actor’s own draft Offer and writes an edited history row', async () => {
    const r = rig();
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      handling: 'SEALED_ORIGINAL',
    });
    expect(outcome).toEqual({ ok: true, value: { changedFields: ['handling'] } });
    expect(r.saved[0]!.state).toMatchObject({
      handling: 'SEALED_ORIGINAL',
      version: 3,
      status: 'draft',
    });
    expect(r.saved[0]!.pendingHistory).toMatchObject({
      changeKind: 'edited',
      changedFields: ['handling'],
    });
    expect(r.reserved).toHaveLength(1);
  });

  it('makes a following submit pass the handling check', () => {
    const offer = Offer.restore(offerState());
    expect(offer.submit({ approvalRequired: true, now: T0 })).toMatchObject({
      ok: false,
      error: { code: 'offer.handling-missing' },
    });
    expect(offer.setHandling({ handling: 'FRESH', now: T0 }).ok).toBe(true);
    const next = Offer.restore(offer.state);
    expect(next.submit({ approvalRequired: true, now: T0 }).ok).toBe(true);
  });

  it('stores nothing when a draft already holds the value', async () => {
    const r = rig({ offer: offerState({ handling: 'REPACKED' }) });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      handling: 'REPACKED',
    });
    expect(outcome).toEqual({ ok: true, value: { changedFields: [] } });
    expect(r.saved[0]!.pendingHistory).toBeNull();
    expect(r.saved[0]!.state.version).toBe(2);
  });

  it('returns a waiting Offer to draft', async () => {
    const r = rig({
      offer: offerState({ status: 'pending-first-publish', submittedAt: T0, handling: 'FRESH' }),
    });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      handling: 'PREPARED',
    });
    expect(outcome.ok).toBe(true);
    expect(r.saved[0]!.state).toMatchObject({
      status: 'draft',
      submittedAt: null,
      handling: 'PREPARED',
    });
  });

  it('changes a published Offer in place, asking with the new handling for each kept tag', async () => {
    const offer = publishedOffer();
    const r = rig({
      offer,
      tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0)],
    });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: offer.id,
      handling: 'PREPARED',
    });
    expect(outcome).toEqual({ ok: true, value: { changedFields: ['handling'] } });
    expect(r.evaluator.calls).toHaveLength(1);
    expect(r.evaluator.calls[0]!.map((q) => q.handling)).toEqual(['PREPARED']);
    expect(r.saved[0]!.state).toMatchObject({ status: 'published', handling: 'PREPARED' });
    expect(r.saved[0]!.tags[0]!.status).toBe('active');
  });

  it('suspends a tag the new handling no longer allows and takes the Offer off sale', async () => {
    const offer = publishedOffer();
    const r = rig({
      offer,
      tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0)],
      refuseHandling: 'REPACKED',
    });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: offer.id,
      handling: 'REPACKED',
    });
    expect(outcome.ok).toBe(true);
    expect(r.saved[0]!.tags[0]).toMatchObject({
      status: 'suspended',
      lastReasonCode: 'handling-not-allowed',
      lastChangeCause: 'handling-change',
    });
    expect(r.saved[0]!.state.listed).toBe(false);
    expect(r.outbox.types).toEqual([
      'catalog.offer-tag-suspended.v1',
      'catalog.offer-listing-changed.v1',
    ]);
  });

  it('refuses the change, storing nothing, when the check is unavailable', async () => {
    const offer = publishedOffer();
    const r = rig({
      offer,
      tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0)],
      unavailable: true,
    });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: offer.id,
      handling: 'PREPARED',
    });
    expect(outcome).toEqual({ ok: false, error: { code: 'claim.check-unavailable' } });
    expect(r.saved).toHaveLength(0);
  });

  it('answers a byte-identical offer.not-found for an unknown, another seller’s and deleted Offer', async () => {
    const other = ids.next<'Seller'>();
    const cases = [
      rig({ offer: null }),
      rig({ offer: offerState({ sellerId: other }) }),
      rig({ offer: offerState({ status: 'deleted', deletedAt: T0 }) }),
    ];
    const answers: string[] = [];
    for (const r of cases) {
      const id = r.state?.id ?? ids.next<'Offer'>();
      answers.push(
        JSON.stringify(
          await r.useCase.execute(contextOf('seller'), { offerId: id, handling: 'FRESH' }),
        ),
      );
      expect(r.saved).toHaveLength(0);
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(JSON.stringify({ ok: false, error: { code: 'offer.not-found' } }));
  });

  it('refuses a bad handling, an unknown key and a bad id before spending the budget', async () => {
    const r = rig();
    const id = r.state!.id;
    for (const input of [
      { offerId: id, handling: 'sealed_original' },
      { offerId: id, handling: 1 },
      { offerId: id, handling: undefined },
      { offerId: id, handling: 'FRESH', attestation: true },
      { offerId: 'nope', handling: 'FRESH' },
    ]) {
      const outcome = await r.useCase.execute(contextOf('seller'), input);
      expect(outcome).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    }
    expect(r.reserved).toHaveLength(0);
    expect(r.saved).toHaveLength(0);
  });

  it('refuses a non-seller actor, an ineligible seller and a spent budget', async () => {
    const r = rig();
    const input = { offerId: r.state!.id, handling: 'FRESH' };
    expect(await r.useCase.execute(contextOf('customer'), input)).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    const ineligible = rig({ eligible: false });
    expect(
      await ineligible.useCase.execute(contextOf('seller'), {
        ...input,
        offerId: ineligible.state!.id,
      }),
    ).toEqual({ ok: false, error: { code: 'seller.not-eligible' } });
    const throttled = rig({ reserve: { code: 'request.throttled', retryAfterSeconds: 7 } });
    expect(
      await throttled.useCase.execute(contextOf('seller'), {
        ...input,
        offerId: throttled.state!.id,
      }),
    ).toEqual({ ok: false, error: { code: 'request.throttled', retryAfterSeconds: 7 } });
    expect(throttled.saved).toHaveLength(0);
  });

  it('asks again after a stale save and answers conflict.retry after the last attempt', async () => {
    const r = rig({ saveThrows: new StaleAggregateError('Offer', 'x') });
    const outcome = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      handling: 'FRESH',
    });
    expect(outcome).toEqual({ ok: false, error: { code: 'conflict.retry' } });
  });
});
