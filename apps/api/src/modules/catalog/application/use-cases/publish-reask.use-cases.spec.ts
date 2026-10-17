import { Temporal } from '@mondapac/shared-kernel';
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
  RecordingOutbox,
  activeTagState,
  allowedDecision,
  refusedDecision,
} from '../../../../../test/support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { OfferListingsMap } from '../../contracts/catalog.facade';
import { Offer, type OfferState } from '../../domain/offer';
import type { ClaimFacts, OfferTagState, TagClaimQuery, TagDecision } from '../../domain/offer-tag';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferListingsReader } from '../ports/offer-listings.reader';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import {
  NO_COUNTS,
  type PendingReevaluation,
  type ReevaluationCounts,
  type TagReevaluationRequestRepository,
} from '../ports/tag-reevaluation-requests';
import { OfferApprove } from './offer-approve.use-case';
import { OfferListingsQuery } from './offer-listings.use-case';
import { OfferListingsSystemQuery } from './offer-listings-system.use-case';
import { ReevaluateTags } from './reevaluate-tags.use-case';

// Slice 11 (catalog design 5.1a point 3, 5.4, 9.1; Hassan's slice 8 conditions, M1, L3, L7): the
// re-ask of kept tags at `offer.approve` before the Offer is published, the fan-out job that
// settles the `rechecking` tags of a PLATFORM publish, and the `offerListings` pair. In memory on
// both Market fixtures with each Market's own type code; the database half (the product lock
// against a racing publish, the fan-out queue) is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');

describe.each([
  ['AU', 'halal'],
  ['ZZ', 'zz-cert'],
] as const)('publication re-ask in market %s', (code, typeCode) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const productId = ids.next<'Product'>();
  const variantIds = [ids.next<'Variant'>(), ids.next<'Variant'>()];
  const certificate = {
    certificateId: ids.next(),
    versionId: ids.next(),
    typeRevisionId: ids.next(),
  };
  const facts: ClaimFacts = {
    productId,
    productRevisionId: ids.next<'ProductRevision'>(),
    revisionPublished: true,
    variantIds,
    platformCategoryPaths: [[ids.next<'Category'>()]],
  };
  const allow = (query: TagClaimQuery): TagDecision => allowedDecision(query, certificate);

  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );

  const offerState = (overrides: Partial<OfferState> = {}): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
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
    ...overrides,
  });

  /** A unit of work that refuses nesting, and an evaluator that refuses an open unit. */
  function units() {
    let open = 0;
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
        if (open > 0) throw new Error('units do not nest');
        open += 1;
        try {
          return await work();
        } finally {
          open -= 1;
        }
      },
    } as unknown as UnitOfWork;
    const evaluator = new FakeClaimEvaluator(allow, [typeCode]);
    const evaluate = evaluator.evaluate.bind(evaluator);
    evaluator.evaluate = (context, queries) => {
      if (open > 0) throw new Error('the evaluator was called inside an open unit');
      return evaluate(context, queries);
    };
    return { unitOfWork, evaluator, inUnit: () => open > 0 };
  }

  /** An in-memory Offer store over the given Offers (with their open tags). */
  function store(initial: readonly { state: OfferState; tags: readonly OfferTagState[] }[]) {
    const rows = new Map(initial.map((row) => [row.state.id, row]));
    const saved: Offer[] = [];
    const offers: OfferRepository = {
      add: () => Promise.reject(new Error('unused')),
      listPendingReview: () => Promise.resolve([]),
      listOnProduct: (_m, product, page) =>
        Promise.resolve(
          [...rows.values()]
            .filter((row) => row.state.productId === product && row.state.status !== 'deleted')
            .sort((a, b) => (a.state.id < b.state.id ? -1 : 1))
            .filter((row) => page.afterId === null || row.state.id > page.afterId)
            .slice(0, page.limit)
            .map((row) => Offer.restore(row.state, row.tags)),
        ),
      findById: (_m, id) => {
        const row = rows.get(id);
        return Promise.resolve(row === undefined ? null : Offer.restore(row.state, row.tags));
      },
      save: (_m, offer) => {
        saved.push(offer);
        rows.set(offer.state.id, {
          state: offer.state,
          tags: offer.tags.filter((tag) => tag.status !== 'removed'),
        });
        return Promise.resolve(null);
      },
    };
    return { offers, saved, rows };
  }

  describe('offer.approve re-asks every kept tag before publishing (5.1a point 3)', () => {
    function rig(tags: () => OfferTagState[]) {
      const state = offerState({
        status: 'pending-first-publish',
        listed: false,
        firstPublishedAt: null,
      });
      const { unitOfWork, evaluator } = units();
      const { offers, saved, rows } = store([{ state, tags: tags() }]);
      const claims = new FixedFactsClaimQueryBuilder(facts);
      const outbox = new RecordingOutbox();
      const approve = new OfferApprove(gate, {
        unitOfWork,
        offers,
        products: {
          findById: () => Promise.resolve({ state: { status: 'published', typeCode: 'simple' } }),
        } as unknown as ProductRepository,
        eligibility: { isEligible: () => Promise.resolve(true) },
        allowedTypes: { allowedFor: () => Promise.resolve('all' as const) },
        check: {} as CheckClaimText,
        outbox,
        clock,
        claims,
        evaluator,
      });
      const run = () => approve.execute(admin(), { offerId: state.id, version: state.version });
      return { run, evaluator, claims, saved, rows, outbox, state };
    }
    const tagged = () => [
      activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0, {
        copyRevisionId: facts.productRevisionId,
      }),
    ];

    it('publishes with the tag kept active on a fresh allowed answer, asked outside the unit', async () => {
      const { run, evaluator, claims, saved, outbox } = rig(() => tagged());
      expect(await run()).toEqual({ ok: true, value: {} });
      expect(evaluator.calls).toHaveLength(1);
      expect(evaluator.calls[0]!.map((q) => q.variantId)).toEqual(variantIds);
      expect(claims.locks).toBe(1);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.state).toMatchObject({ status: 'published', listed: true });
      expect(saved[0]!.tags[0]).toMatchObject({ status: 'active' });
      expect(outbox.types).toEqual(['catalog.offer-published.v1']);
    });

    it('publishes off sale with the tag suspended when the answer is now a refusal', async () => {
      const { run, evaluator, saved, outbox } = rig(() => tagged());
      evaluator.decide = (q) => refusedDecision(q, 'no-valid-seller-certificate');
      expect(await run()).toEqual({ ok: true, value: {} });
      expect(saved[0]!.state).toMatchObject({
        status: 'published',
        listed: false,
        offSaleCauses: ['tag-suspended'],
      });
      expect(saved[0]!.tags[0]).toMatchObject({
        status: 'suspended',
        badge: null,
        lastChangeCause: 'offer-approve',
      });
      expect(outbox.types).toEqual([
        'catalog.offer-tag-suspended.v1',
        'catalog.offer-published.v1',
      ]);
    });

    it('refuses with claim.check-unavailable and publishes nothing when the ask is unanswered', async () => {
      const { run, evaluator, saved } = rig(() => tagged());
      evaluator.unavailable = true;
      expect(await run()).toEqual({ ok: false, error: { code: 'claim.check-unavailable' } });
      expect(saved).toEqual([]);
    });

    it('asks again when a revision was published since the ask, then refuses conflict.retry', async () => {
      const { run, evaluator, claims, saved } = rig(() => tagged());
      claims.lockFails = true;
      expect(await run()).toEqual({ ok: false, error: { code: 'conflict.retry' } });
      expect(evaluator.calls).toHaveLength(3);
      expect(saved).toEqual([]);
    });

    it('asks nothing and takes no lock for an Offer without tags', async () => {
      const { run, evaluator, claims, saved } = rig(() => []);
      expect(await run()).toEqual({ ok: true, value: {} });
      expect(evaluator.calls).toEqual([]);
      expect(claims.locks).toBe(0);
      expect(saved[0]!.state.status).toBe('published');
    });
  });

  describe('catalog.reevaluate-tags (the fan-out of a PLATFORM publish, design 5.4)', () => {
    class MemoryRequests implements TagReevaluationRequestRepository {
      readonly rows: (PendingReevaluation & { state: 'pending' | 'settled' | 'superseded' })[] = [];
      progressed = 0;

      requestForPublish(
        _m: MarketContext,
        request: { productId: Id<'Product'>; productRevisionId: Id<'ProductRevision'> },
      ): Promise<void> {
        for (const row of this.rows) {
          if (row.productId === request.productId && row.state === 'pending') {
            row.state = 'superseded';
          }
        }
        this.rows.push({
          id: ids.next<'TagReevaluationRequest'>(),
          productId: request.productId,
          productRevisionId: request.productRevisionId,
          cursorOfferId: null,
          counts: NO_COUNTS,
          state: 'pending',
        });
        return Promise.resolve();
      }

      listPending(_m: MarketContext, limit: number): Promise<readonly PendingReevaluation[]> {
        return Promise.resolve(
          this.rows
            .filter((row) => row.state === 'pending')
            .slice(0, limit)
            .map((r) => ({ ...r })),
        );
      }

      progress(
        _m: MarketContext,
        id: Id<'TagReevaluationRequest'>,
        update: { cursorOfferId: Id<'Offer'>; counts: ReevaluationCounts },
      ): Promise<boolean> {
        const row = this.rows.find((r) => r.id === id);
        if (row?.state !== 'pending') return Promise.resolve(false);
        if (row.cursorOfferId !== null && update.cursorOfferId <= row.cursorOfferId) {
          return Promise.resolve(false);
        }
        this.progressed += 1;
        Object.assign(row, update);
        return Promise.resolve(true);
      }

      close(
        _m: MarketContext,
        id: Id<'TagReevaluationRequest'>,
        end: { state: 'settled' | 'superseded'; counts: ReevaluationCounts },
      ): Promise<boolean> {
        const row = this.rows.find((r) => r.id === id);
        if (row?.state !== 'pending') return Promise.resolve(false);
        Object.assign(row, { state: end.state, counts: end.counts });
        return Promise.resolve(true);
      }
    }

    /** Offers on the product whose tags a PLATFORM publish marked `rechecking` (M1). */
    function rig(count: number) {
      const rows = Array.from({ length: count }, () => {
        const state = offerState();
        const marked = Offer.restore(state, [
          activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0, {
            copyRevisionId: facts.productRevisionId,
          }),
        ]);
        marked.markRechecking({
          entryPath: 'revision-publish',
          actor: { kind: 'admin', accountId: ids.next<'Account'>() },
          now: T0,
        });
        return { state: { ...marked.state, version: state.version + 1 }, tags: marked.tags };
      });
      const { unitOfWork, evaluator } = units();
      const { offers, saved, rows: stored } = store(rows);
      const claims = new FixedFactsClaimQueryBuilder(facts);
      const outbox = new RecordingOutbox();
      const requests = new MemoryRequests();
      void requests.requestForPublish(market, {
        productId,
        productRevisionId: facts.productRevisionId,
      });
      const job = new ReevaluateTags(gate, {
        unitOfWork,
        requests,
        offers,
        claims,
        evaluator,
        outbox,
        clock,
      });
      const run = () => job.execute(testCallContext(market, 'system'), {});
      return { run, evaluator, claims, saved, stored, outbox, requests };
    }

    it('restores every rechecking tag on an allowed answer and settles the request', async () => {
      const { run, evaluator, stored, requests, outbox } = rig(3);
      expect(await run()).toEqual({ ok: true, value: { closed: 1, open: 0 } });
      // One batched ask for the page: 3 Offers x 2 variants.
      expect(evaluator.calls.map((call) => call.length)).toEqual([6]);
      for (const row of stored.values()) {
        expect(row.tags[0]).toMatchObject({
          status: 'active',
          lastChangeCause: 'revision-publish',
        });
        expect(row.tags[0]!.badge).not.toBeNull();
      }
      expect(requests.rows[0]).toMatchObject({
        state: 'settled',
        counts: { asked: 6, kept: 3, suspended: 0, unavailable: 0 },
      });
      expect(outbox.appended).toEqual([]);
    });

    it('suspends a tag refused against the new revision, taking its Offer off sale', async () => {
      const { run, evaluator, stored, outbox } = rig(1);
      evaluator.decide = (q) => refusedDecision(q, 'policy-not-applicable');
      expect(await run()).toMatchObject({ ok: true });
      const [row] = [...stored.values()];
      expect(row!.tags[0]).toMatchObject({ status: 'suspended', badge: null });
      expect(row!.state).toMatchObject({ listed: false, offSaleCauses: ['tag-suspended'] });
      expect(outbox.types).toEqual([
        'catalog.offer-tag-suspended.v1',
        'catalog.offer-listing-changed.v1',
      ]);
    });

    it('is idempotent: a second run takes no settled request and changes nothing', async () => {
      const { run, evaluator, saved } = rig(2);
      await run();
      const writes = saved.length;
      expect(await run()).toEqual({ ok: true, value: { closed: 0, open: 0 } });
      expect(saved).toHaveLength(writes);
      expect(evaluator.calls).toHaveLength(1);
    });

    it('fails closed when the ask is unanswered: tags stay rechecking, the request stays pending', async () => {
      const { run, evaluator, stored, requests } = rig(2);
      evaluator.unavailable = true;
      expect(await run()).toEqual({ ok: true, value: { closed: 0, open: 1 } });
      for (const row of stored.values()) {
        expect(row.tags[0]).toMatchObject({ status: 'rechecking', badge: null });
      }
      expect(requests.rows[0]).toMatchObject({ state: 'pending', cursorOfferId: null });
      evaluator.unavailable = false;
      expect(await run()).toEqual({ ok: true, value: { closed: 1, open: 0 } });
      for (const row of stored.values()) expect(row.tags[0]!.status).toBe('active');
    });

    it('leaves the request pending when the product moved since the ask (the lock fails)', async () => {
      const { run, claims, saved, requests } = rig(1);
      claims.lockFails = true;
      expect(await run()).toEqual({ ok: true, value: { closed: 0, open: 1 } });
      expect(saved).toEqual([]);
      expect(requests.rows[0]!.state).toBe('pending');
    });

    it('supersedes a request whose revision is no longer the published one', async () => {
      const { run, claims, evaluator, saved, requests } = rig(1);
      claims.published = { ...facts, productRevisionId: ids.next<'ProductRevision'>() };
      expect(await run()).toEqual({ ok: true, value: { closed: 1, open: 0 } });
      expect(requests.rows[0]!.state).toBe('superseded');
      expect(evaluator.calls).toEqual([]);
      expect(saved).toEqual([]);
    });

    it('runs only as the system actor', async () => {
      const { requests } = rig(1);
      const { unitOfWork, evaluator } = units();
      const job = new ReevaluateTags(gate, {
        unitOfWork,
        requests,
        offers: store([]).offers,
        claims: new FixedFactsClaimQueryBuilder(facts),
        evaluator,
        outbox: new RecordingOutbox(),
        clock,
      });
      expect(await job.execute(admin(), {})).toMatchObject({ ok: false });
    });
  });

  describe('offerListings (design 9.1; Hassan L3, L7, certification revoke review)', () => {
    function rig() {
      const reads: string[] = [];
      const reader: OfferListingsReader = {
        read: (_m, _keys, locales, tags) => {
          reads.push(tags);
          expect(locales.fallback).toBe('fallback-locale');
          return Promise.resolve(new Map() as OfferListingsMap);
        },
      };
      const deps = {
        unitOfWork: units().unitOfWork,
        listingsReader: reader,
        policy: {
          locales: () => ({ default: 'fallback-locale' }),
        } as unknown as CatalogMarketPolicy,
      };
      return {
        reads,
        anonymous: new OfferListingsQuery(gate, deps),
        system: new OfferListingsSystemQuery(gate, deps),
      };
    }
    const key = () => ({ offerId: ids.next<'Offer'>(), variantId: ids.next<'Variant'>() });

    it('reads no tag for an anonymous caller, live tags for the system (slice 12 gate)', async () => {
      const { reads, anonymous, system } = rig();
      const input = { keys: [key()], locale: 'en' };
      expect(await anonymous.execute(testCallContext(market, 'anonymous'), input)).toMatchObject({
        ok: true,
      });
      expect(await system.execute(testCallContext(market, 'system'), input)).toMatchObject({
        ok: true,
      });
      expect(reads).toEqual(['none', 'live']);
    });

    it('refuses more than 200 keys whole and malformed ids, reading nothing', async () => {
      const { reads, anonymous } = rig();
      const context = testCallContext(market, 'anonymous');
      const many = Array.from({ length: 201 }, key);
      expect(await anonymous.execute(context, { keys: many, locale: 'en' })).toEqual({
        ok: false,
        error: { code: 'batch.too-large' },
      });
      expect(
        await anonymous.execute(context, {
          keys: [{ offerId: 'x', variantId: 'y' }],
          locale: 'en',
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(
        await anonymous.execute(context, { keys: [key()], locale: 'not a locale' }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(reads).toEqual([]);
    });
  });
});
