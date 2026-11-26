import {
  InMemoryOfferPendingChanges,
  memoryOfferEditReview,
} from '../../../../../test/support/catalog-offer-edit-review-fakes';
import {
  fixedSampler,
  InMemoryOfferPostReviews,
} from '../../../../../test/support/catalog-offer-post-review-fakes';
import {
  InMemorySellerReviewStandings,
  memoryProbation,
} from '../../../../../test/support/catalog-seller-review-fakes';
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
import { Offer, type OfferState } from '../../domain/offer';
import type { ClaimFacts, OfferTagState, TagClaimQuery } from '../../domain/offer-tag';
import { CategoryPathsUnavailableError } from '../ports/category-paths.reader';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { AuditEntry } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type {
  OfferReviewInputs,
  OfferReviewFactsRead,
  OfferReviewReferral,
  OfferReviewSettings,
} from '../ports/offer-review';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import { OwnOfferAddTag } from './own-offer-add-tag.use-case';
import { OwnOfferRemoveTag } from './own-offer-remove-tag.use-case';
import { OwnOfferRemoveSuspendedTag } from './own-offer-remove-suspended-tag.use-case';
import { OwnOfferSubmit } from './own-offer-submit.use-case';
import { OwnOfferEdit } from './own-offer-edit.use-case';
import { AdminOfferPostReviewTakeDown } from './offer-post-review-take-down.use-case';
import { OfferPostReview } from '../../domain/offer-post-review';
import { FacadeOfferReviewInputs } from '../../infrastructure/facade-offer-review-inputs';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { SettingsFacade } from '../../../settings';
import { FLAGS_OFF } from '../../../../../test/support/catalog-seller-review-fakes';

// Certification tags on a seller's own Offer (catalog design 5.1 to 5.3, 5.1a point 6; CERT-21;
// AC 7 to 9, 14, 15): `own-offer.add-tag`, `own-offer.remove-tag` and the `requestedTags` of
// `own-offer.submit`, in memory on both Market fixtures with each Market's own type code. The
// decision is the evaluator's; catalog judges every variant and the equality of the returned
// inputs with the state it saves. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');

describe.each([
  ['AU', 'halal'],
  ['ZZ', 'zz-cert'],
] as const)('own-offer tags in market %s', (code, typeCode) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const variantIds = [ids.next<'Variant'>(), ids.next<'Variant'>()];
  const certificate = {
    certificateId: ids.next(),
    versionId: ids.next(),
    typeRevisionId: ids.next(),
  };

  const contextOf = (population: 'admin' | 'seller' | 'customer', owner = sellerId): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? owner : null,
      }),
    );

  /** A seller context whose actor carries the reserved acting-as marker (SEL-08). */
  const actingAs = (): CallContext => {
    const context = contextOf('seller');
    const actor = { ...context.actor, actingAs: { adminAccountId: ids.next() } };
    return { ...context, actor: actor };
  };

  const offerState = (overrides: Partial<OfferState> = {}): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
    sellerId,
    productId: ids.next<'Product'>(),
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

  const factsOf = (state: OfferState): ClaimFacts => ({
    productId: state.productId,
    productRevisionId: ids.next<'ProductRevision'>(),
    revisionPublished: true,
    variantIds,
    platformCategoryPaths: [[ids.next<'Category'>()]],
  });

  function rig(
    options: {
      offer?: OfferState | null;
      tags?: OfferTagState[];
      published?: boolean;
      /** A published product that an admin paused (design 4.1a). */
      paused?: boolean;
      decide?: (query: TagClaimQuery) => ReturnType<typeof allowedDecision>;
      unavailable?: boolean;
      /** Each read of the Offer after the first answers this version (another write landed). */
      laterVersion?: number;
      /** The Offer review settings; default risk-based with automatic badges (publishes). */
      review?: OfferReviewSettings;
      reviewFacts?: Partial<OfferReviewFactsRead>;
      /** The settings read rejects (the real adapter never does; the use case must not publish). */
      reviewInputsFail?: boolean;
      /** The referral write throws in the unit. */
      referralFails?: boolean;
      /** The sampler's fixed bucket (default 9999, never drawn under 100%), or a throw. */
      bucket?: number | 'throw';
      /** The post-publication rows (shared with a take-down in the same test). */
      postReviews?: InMemoryOfferPostReviews;
      /** The review inputs in place of the fixed fake (the real facade adapter). */
      reviewInputs?: OfferReviewInputs;
    } = {},
  ) {
    let current: { state: OfferState; tags: readonly OfferTagState[] } | null =
      options.offer === null
        ? null
        : { state: options.offer ?? offerState(), tags: options.tags ?? [] };
    const initial = current;
    const saved: Offer[] = [];
    let reads = 0;
    let openUnits = 0;
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
        if (openUnits > 0) throw new Error('units do not nest');
        openUnits += 1;
        try {
          return await work();
        } finally {
          openUnits -= 1;
        }
      },
    } as unknown as UnitOfWork;
    const evaluator = new FakeClaimEvaluator(
      options.decide ?? ((query) => allowedDecision(query, certificate)),
      [typeCode],
    );
    evaluator.unavailable = options.unavailable ?? false;
    const evaluate = evaluator.evaluate.bind(evaluator);
    evaluator.evaluate = (context, queries) => {
      if (openUnits > 0) throw new Error('the evaluator was called inside an open unit');
      return evaluate(context, queries);
    };
    const outbox = new RecordingOutbox();
    const referrals: OfferReviewReferral[] = [];
    const audits: AuditEntry[] = [];
    const audit = {
      record: (_c: CallContext, entry: AuditEntry) => {
        if (openUnits === 0) throw new Error('audited outside a unit');
        audits.push(entry);
        return Promise.resolve();
      },
    } satisfies AuditWriter;
    const facts = initial === null ? null : factsOf(initial.state);
    const claims = new FixedFactsClaimQueryBuilder(options.published === false ? null : facts);
    const offers: OfferRepository = {
      add: () => Promise.reject(new Error('unused')),
      listOnProduct: () => Promise.resolve([]),
      listPendingReview: () => Promise.resolve([]),
      findManyByIds: () => Promise.resolve([]),
      findById: (_m, id) => {
        reads += 1;
        if (current === null || current.state.id !== id) return Promise.resolve(null);
        const version =
          reads > 1 && options.laterVersion !== undefined
            ? options.laterVersion
            : current.state.version;
        return Promise.resolve(Offer.restore({ ...current.state, version }, current.tags));
      },
      save: (_m, offer) => {
        if (openUnits === 0) throw new Error('saved outside a unit');
        saved.push(offer);
        current = { state: offer.state, tags: offer.tags.filter((t) => t.status !== 'removed') };
        return Promise.resolve(null);
      },
    };
    const eligibility = { isEligible: () => Promise.resolve(true) };
    const add = new OwnOfferAddTag(gate, {
      editReview: memoryOfferEditReview({ ids }).review,
      unitOfWork,
      offers,
      eligibility,
      save: { reserveSaves: () => Promise.resolve(null) },
      claims,
      evaluator,
      outbox,
      clock,
      ids,
    });
    const remove = new OwnOfferRemoveTag(gate, { unitOfWork, offers, eligibility, outbox, clock });
    const sellWithoutBadge = new OwnOfferRemoveSuspendedTag(gate, {
      unitOfWork,
      offers,
      eligibility,
      outbox,
      clock,
    });
    const products = {
      findById: (_m: MarketContext, id: Id<'Product'>) =>
        Promise.resolve({
          state: {
            id,
            status: options.published === false ? 'unpublished' : 'published',
            pausedAt: options.paused === true ? T0 : null,
            typeCode: 'simple',
          },
        }),
    } as unknown as ProductRepository;
    const check = {
      execute: (_c: CallContext, texts: readonly { locale: string }[]) =>
        Promise.resolve({
          ok: true as const,
          value: texts.map((t) => ({
            code: 'clean' as const,
            field: 'offer.description' as const,
            ref: null,
            locale: t.locale,
          })),
        }),
    } as unknown as CheckClaimText;
    const probationStandings = new InMemorySellerReviewStandings();
    const sampler = fixedSampler(options.bucket ?? 9999);
    const postReviews = options.postReviews ?? new InMemoryOfferPostReviews();
    const submit = new OwnOfferSubmit(gate, {
      unitOfWork,
      offers,
      products,
      eligibility,
      allowedTypes: { allowedFor: () => Promise.resolve('all' as const) },
      check,
      reviewInputs: options.reviewInputs ?? {
        settings: () =>
          options.reviewInputsFail === true
            ? Promise.reject(new Error('settings down'))
            : Promise.resolve(
                options.review ?? {
                  mode: 'risk-based',
                  certificateBadges: 'automatic',
                  emergencyStop: false,
                },
              ),
        facts: () =>
          Promise.resolve({
            emergencyStop: false,
            probation: false,
            fullReview: false,
            sensitiveCategory: false,
            degraded: false,
            stampTrust: false,
            probationOffers: 10,
            ...options.reviewFacts,
          }),
        probationOffers: () => Promise.resolve(10),
      },
      referrals: {
        record: (_m, referral) => {
          if (openUnits === 0) throw new Error('recorded outside a unit');
          if (options.referralFails === true) throw new Error('insert failed');
          referrals.push(referral);
          return Promise.resolve();
        },
      },
      audit,
      outbox,
      claims,
      evaluator,
      clock,
      ids,
      probation: memoryProbation({ standings: probationStandings }).probation,
      sampler,
      postReviews,
      counterWindows: { isOpen: () => Promise.resolve(false) },
      counterKeys: { keyOf: () => new Uint8Array(32) },
    });
    return {
      add,
      remove,
      sellWithoutBadge,
      submit,
      saved,
      outbox,
      referrals,
      audits,
      evaluator,
      claims,
      offerId: initial?.state.id ?? ids.next<'Offer'>(),
      current: () => current,
      probationStandings,
      sampler,
      postReviews,
      unitOfWork,
      offers,
      check,
    };
  }

  describe('own-offer.add-tag', () => {
    it('writes the tag active with the badge of this request and announces it', async () => {
      const r = rig();
      const outcome = await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode });
      expect(outcome).toEqual({
        ok: true,
        value: { typeCode, status: 'active', basis: 'SELLER', applied: true },
      });
      expect(r.evaluator.calls).toHaveLength(1);
      expect(r.evaluator.calls[0]!.map((q) => [q.variantId, q.sellerId, q.handling])).toEqual(
        variantIds.map((id) => [id, sellerId, 'SEALED_ORIGINAL']),
      );
      const tag = r.current()!.tags[0]!;
      expect(tag).toMatchObject({ typeCode, status: 'active', changeSeq: 1 });
      expect(tag.badge).toMatchObject({ typeCode, typeRevisionId: certificate.typeRevisionId });
      expect(r.saved[0]!.pendingTagHistory).toEqual([
        expect.objectContaining({ toStatus: 'active', entryPath: 'tag-add' }),
      ]);
      expect(r.outbox.types).toEqual(['catalog.offer-tag-added.v1']);
      expect(r.outbox.appended[0]!.payload).toEqual({
        offerId: r.offerId,
        tagId: tag.id,
        basis: 'seller',
      });
    });

    it('refuses when the evaluator does not allow the type, naming the reason, storing nothing', async () => {
      const r = rig({ decide: (query) => refusedDecision(query, 'no-certificate') });
      expect(await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode })).toEqual({
        ok: false,
        error: { code: 'claim.tag-not-allowed', tags: [{ typeCode, reason: 'no-certificate' }] },
      });
      expect(r.saved).toHaveLength(0);
      expect(r.outbox.appended).toHaveLength(0);
    });

    it('refuses when one variant is not allowed even if the others are (variant fail-closed)', async () => {
      const r = rig({
        decide: (query) =>
          query.variantId === variantIds[1]
            ? refusedDecision(query, 'category-not-covered')
            : allowedDecision(query, certificate),
      });
      expect(await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode })).toEqual({
        ok: false,
        error: {
          code: 'claim.tag-not-allowed',
          tags: [{ typeCode, reason: 'category-not-covered' }],
        },
      });
      expect(r.saved).toHaveLength(0);
    });

    it('fails closed when the check is unavailable', async () => {
      const r = rig({ unavailable: true });
      expect(await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode })).toEqual({
        ok: false,
        error: { code: 'claim.check-unavailable' },
      });
      expect(r.saved).toHaveLength(0);
    });

    it('never activates on decisions whose inputs differ from the state being saved', async () => {
      const r = rig({
        decide: (query) =>
          allowedDecision(query, certificate, { inputs: { ...query, handling: 'FRESH' } }),
      });
      expect(await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode })).toEqual({
        ok: false,
        error: { code: 'conflict.retry' },
      });
      expect(r.evaluator.calls).toHaveLength(3);
      expect(r.saved).toHaveLength(0);
    });

    it('asks again when another write landed between the ask and the write', async () => {
      const r = rig({ laterVersion: 4 });
      const outcome = await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode });
      expect(outcome.ok).toBe(true);
      expect(r.evaluator.calls).toHaveLength(2);
      expect(r.saved).toHaveLength(1);
    });

    it('refuses an unknown type, an unpublished product, a missing handling and an existing tag', async () => {
      const unknown = rig();
      expect(
        await unknown.add.execute(contextOf('seller'), {
          offerId: unknown.offerId,
          typeCode: 'other-type',
        }),
      ).toEqual({ ok: false, error: { code: 'tag.type-unknown' } });
      const unpublished = rig({ published: false });
      expect(
        await unpublished.add.execute(contextOf('seller'), {
          offerId: unpublished.offerId,
          typeCode,
        }),
      ).toEqual({ ok: false, error: { code: 'tag.product-not-published' } });
      const noHandling = rig({ offer: offerState({ handling: null }) });
      expect(
        await noHandling.add.execute(contextOf('seller'), {
          offerId: noHandling.offerId,
          typeCode,
        }),
      ).toEqual({ ok: false, error: { code: 'offer.handling-missing' } });
      const exists = rig({
        tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0)],
      });
      expect(
        await exists.add.execute(contextOf('seller'), { offerId: exists.offerId, typeCode }),
      ).toEqual({ ok: false, error: { code: 'tag.exists' } });
      for (const r of [unknown, unpublished, noHandling, exists]) {
        expect(r.evaluator.calls).toHaveLength(0);
        expect(r.saved).toHaveLength(0);
      }
    });

    it('answers one offer.not-found for an unknown, another seller’s and a deleted Offer', async () => {
      const cases = [
        rig({ offer: null }),
        rig({ offer: offerState({ sellerId: ids.next<'Seller'>() }) }),
        rig({ offer: offerState({ status: 'deleted', deletedAt: T0, listed: false }) }),
      ];
      for (const r of cases) {
        expect(await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode })).toEqual({
          ok: false,
          error: { code: 'offer.not-found' },
        });
        expect(r.saved).toHaveLength(0);
      }
    });

    it.each(['basis', 'badge', 'status', 'certificateId', 'sellerId', 'decision'])(
      'refuses a request that names %s: a decision or badge never comes from the client',
      async (key) => {
        const r = rig();
        expect(
          await r.add.execute(contextOf('seller'), {
            offerId: r.offerId,
            typeCode,
            [key]: 'x',
          }),
        ).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] },
        });
        expect(r.evaluator.calls).toHaveLength(0);
      },
    );

    it('refuses an admin and a customer', async () => {
      const r = rig();
      for (const population of ['admin', 'customer'] as const) {
        expect(
          await r.add.execute(contextOf(population), { offerId: r.offerId, typeCode }),
        ).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });
  });

  describe('own-offer.remove-tag', () => {
    it('removes an active tag, records the seller and announces it, asking nothing', async () => {
      const tagId = ids.next<'OfferTag'>();
      const r = rig({ tags: [activeTagState(tagId, typeCode, certificate, T0)] });
      expect(await r.remove.execute(contextOf('seller'), { offerId: r.offerId, typeCode })).toEqual(
        {
          ok: true,
          value: {},
        },
      );
      expect(r.evaluator.calls).toHaveLength(0);
      expect(r.saved[0]!.tags[0]).toMatchObject({
        status: 'removed',
        removedByKind: 'seller',
        badge: null,
        changeSeq: 2,
      });
      expect(r.outbox.types).toEqual(['catalog.offer-tag-removed.v1']);
    });

    it('refuses a suspended tag, an unknown type and another seller’s Offer', async () => {
      const suspended = rig({
        tags: [
          activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0, {
            status: 'suspended',
            badge: null,
            lastReasonCode: 'certificate-expired',
            changeSeq: 2,
          }),
        ],
      });
      expect(
        await suspended.remove.execute(contextOf('seller'), {
          offerId: suspended.offerId,
          typeCode,
        }),
      ).toEqual({ ok: false, error: { code: 'tag.suspended' } });
      const none = rig();
      expect(
        await none.remove.execute(contextOf('seller'), { offerId: none.offerId, typeCode }),
      ).toEqual({
        ok: false,
        error: { code: 'tag.not-found' },
      });
      const other = rig({
        offer: offerState({ sellerId: ids.next<'Seller'>() }),
        tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0)],
      });
      expect(
        await other.remove.execute(contextOf('seller'), { offerId: other.offerId, typeCode }),
      ).toEqual({
        ok: false,
        error: { code: 'offer.not-found' },
      });
      for (const r of [suspended, none, other]) expect(r.saved).toHaveLength(0);
    });
  });

  describe('own-offer.submit with requestedTags', () => {
    const draft = () =>
      offerState({ status: 'draft', listed: false, submittedAt: null, firstPublishedAt: null });

    it('publishes the Offer and writes each requested tag active in the same unit', async () => {
      const r = rig({ offer: draft() });
      const outcome = await r.submit.execute(contextOf('seller'), {
        offerId: r.offerId,
        requestedTags: [typeCode],
      });
      expect(outcome).toEqual({ ok: true, value: { published: true } });
      expect(r.saved).toHaveLength(1);
      expect(r.current()!.tags).toEqual([expect.objectContaining({ typeCode, status: 'active' })]);
      expect(r.outbox.types).toContain('catalog.offer-tag-added.v1');
    });

    it('records the review decision and its audit when it publishes at once', async () => {
      const r = rig({ offer: draft() });
      await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(r.referrals).toEqual([
        expect.objectContaining({
          offerId: r.offerId,
          trigger: 'first-publication',
          reasons: [],
          policyVersion: 4,
          offerVersion: r.current()!.state.version,
        }),
      ]);
      expect(r.audits).toEqual([
        expect.objectContaining({
          action: 'catalog.offer.review-referred',
          after: expect.objectContaining({ outcome: 'published', reasons: [] }) as unknown,
        }),
      ]);
    });

    it('sends an Offer taken down after publication to full review when it is resubmitted (R6, chained)', async () => {
      // One store of post-publication rows behind the take-down and the real review inputs.
      const postReviews = new InMemoryOfferPostReviews();
      const directUnit = {
        run: (_m: MarketContext, body: () => Promise<unknown>) => body(),
      } as unknown as UnitOfWork;
      const reviewInputs = new FacadeOfferReviewInputs({
        settings: {
          offerReviewPolicy: () =>
            Promise.resolve({
              mode: 'risk-based',
              probationOffers: 10,
              referenceSellers: 3,
              priceBandPercent: 50,
              samplingPercent: 0,
              certificateBadges: 'automatic',
              emergencyStop: false,
            }),
        } as unknown as SettingsFacade,
        sellerFlags: {
          flagsOf: () => Promise.resolve({ ...FLAGS_OFF, trustedFromStart: { on: true, at: T0 } }),
        },
        unitOfWork: directUnit,
        standings: new InMemorySellerReviewStandings(),
        categoryFlags: {
          listFlagged: () => Promise.resolve([]),
          publishedCategoryIds: () => Promise.resolve([]),
        } as never,
        categoryPaths: { livePaths: () => Promise.resolve([]) } as never,
        postReviews,
      });
      const r = rig({ offer: offerState(), postReviews, reviewInputs });
      // An open post-publication row of the live Offer.
      const opened = OfferPostReview.open({
        id: ids.next<'OfferPostReview'>(),
        marketId: code as MarketId,
        offerId: r.offerId,
        sellerId,
        productId: r.current()!.state.productId,
        reason: 'price-no-reference',
        now: T0,
      });
      if (!opened.ok) throw new Error(opened.error.code);
      postReviews.rows.set(opened.value.state.id, opened.value.state);

      // 1. An admin takes it down: changes needed.
      const takeDown = new AdminOfferPostReviewTakeDown(gate, {
        unitOfWork: r.unitOfWork,
        postReviews,
        offers: r.offers,
        pendingChanges: new InMemoryOfferPendingChanges(),
        editReview: memoryOfferEditReview({ ids }).review,
        probation: memoryProbation().probation,
        audit: { record: () => Promise.resolve() },
        outbox: r.outbox,
        clock,
      });
      expect(
        await takeDown.execute(contextOf('admin'), {
          id: opened.value.state.id,
          version: 1,
          reasonCode: 'description-claim',
          misconduct: false,
          note: 'Claims a certificate',
        }),
      ).toMatchObject({ ok: true, value: { status: 'taken-down' } });
      expect(r.current()!.state.status).toBe('changes-needed');

      // 2. The seller edits it: back to draft.
      const policy = new ConfigCatalogMarketPolicy(markets);
      const edit = new OwnOfferEdit(gate, {
        // No preview mark in these tests (slice 7b): never read past isOpen.
        counterWindows: { isOpen: () => Promise.resolve(false) },
        counterKeys: { keyOf: () => new Uint8Array(32) },
        postReviews: {} as never,
        ids: {
          next: () => {
            throw new Error('ids: not reached');
          },
        } as never,
        unitOfWork: r.unitOfWork,
        offers: r.offers,
        eligibility: { isEligible: () => Promise.resolve(true) },
        check: r.check,
        save: { reserveSaves: () => Promise.resolve(null) },
        policy,
        claims: r.claims,
        evaluator: new FakeClaimEvaluator(
          (query) => allowedDecision(query, certificate),
          [typeCode],
        ),
        outbox: r.outbox,
        clock,
        editReview: memoryOfferEditReview({ ids }).review,
      });
      const edited = await edit.execute(contextOf('seller'), {
        offerId: r.offerId,
        sellerSku: 'SKU-1',
        conditionCode: 'new',
        description: { [policy.locales(market).default]: 'Fresh dates, no claims' },
      });
      expect(edited.ok).toBe(true);
      expect(r.current()!.state.status).toBe('draft');

      // 3. The resubmit reads the take-down: full review (R6), queued, never published at once,
      // although the seller is Trusted from start and nothing else asks for review.
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome).toEqual({ ok: true, value: { published: false } });
      expect(r.current()!.state.status).toBe('pending-first-publish');
      expect(r.referrals.at(-1)?.reasons).toEqual(['full-review']);
    });

    describe('the post-publication sample (risk-based Offer approval slice 6)', () => {
      const settings = (samplingPercent?: number): OfferReviewSettings => ({
        mode: 'risk-based',
        certificateBadges: 'automatic',
        emergencyStop: false,
        ...(samplingPercent === undefined ? {} : { samplingPercent }),
      });
      const rows = (r: ReturnType<typeof rig>) =>
        r.postReviews.ofOffer(r.offerId).map((row) => ({
          marketId: row.marketId,
          reasons: row.reasons,
          samplePercent: row.samplePercent,
          sampleDoubled: row.sampleDoubled,
        }));

      it('draws under the percent with the Market, Offer and saved version, and opens a row', async () => {
        const r = rig({ offer: draft(), review: settings(5), bucket: 499 });
        const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
        // Nothing of the draw reaches the seller.
        expect(outcome).toEqual({ ok: true, value: { published: true } });
        expect(r.sampler.asked).toEqual([
          { marketId: code, offerId: r.offerId, offerVersion: r.current()!.state.version },
        ]);
        expect(rows(r)).toEqual([
          { marketId: code, reasons: ['sample'], samplePercent: 5, sampleDoubled: false },
        ]);
        expect(r.audits[0]).toEqual(
          expect.objectContaining({
            after: expect.objectContaining({ outcome: 'published', sampled: true }) as unknown,
          }),
        );
      });

      it('opens no row at or over the boundary bucket, and audits sampled false', async () => {
        const r = rig({ offer: draft(), review: settings(5), bucket: 500 });
        await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
        expect(rows(r)).toEqual([]);
        expect(r.audits[0]).toEqual(
          expect.objectContaining({
            after: expect.objectContaining({ sampled: false }) as unknown,
          }),
        );
      });

      it('never draws at 0%, and always at 100% without asking the sampler', async () => {
        const none = rig({ offer: draft(), review: settings(0), bucket: 0 });
        await none.submit.execute(contextOf('seller'), { offerId: none.offerId });
        expect([none.sampler.asked, rows(none)]).toEqual([[], []]);
        const all = rig({ offer: draft(), review: settings(100), bucket: 9999 });
        await all.submit.execute(contextOf('seller'), { offerId: all.offerId });
        expect(all.sampler.asked).toEqual([]);
        expect(rows(all)).toEqual([
          { marketId: code, reasons: ['sample'], samplePercent: 100, sampleDoubled: false },
        ]);
      });

      it('samples at the safe 100 without a percent; degraded facts queue the Offer instead', async () => {
        const absent = rig({ offer: draft(), review: settings(), bucket: 9999 });
        await absent.submit.execute(contextOf('seller'), { offerId: absent.offerId });
        expect(rows(absent)).toEqual([
          { marketId: code, reasons: ['sample'], samplePercent: 100, sampleDoubled: false },
        ]);
        const degraded = rig({
          offer: draft(),
          review: { ...settings(0), mode: 'off' },
          reviewFacts: { degraded: true },
          bucket: 9999,
        });
        const outcome = await degraded.submit.execute(contextOf('seller'), {
          offerId: degraded.offerId,
        });
        // Degraded facts are judged in the safe settings (review everything): queued, not drawn.
        expect(outcome).toEqual({ ok: true, value: { published: false } });
        expect([degraded.sampler.asked, rows(degraded)]).toEqual([[], []]);
      });

      it('counts a draw that fails as drawn, logging no key', async () => {
        const r = rig({ offer: draft(), review: settings(5), bucket: 'throw' });
        const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
        expect(outcome).toEqual({ ok: true, value: { published: true } });
        expect(rows(r)).toEqual([
          { marketId: code, reasons: ['sample'], samplePercent: 5, sampleDoubled: false },
        ]);
      });

      it('doubles the percent for a seller Trusted less than 30 days ago', async () => {
        const recent = rig({
          offer: draft(),
          review: settings(5),
          reviewFacts: { trustedSince: T0.subtract({ hours: 24 }) },
          bucket: 999,
        });
        await recent.submit.execute(contextOf('seller'), { offerId: recent.offerId });
        expect(rows(recent)).toEqual([
          { marketId: code, reasons: ['sample'], samplePercent: 10, sampleDoubled: true },
        ]);
        const old = rig({
          offer: draft(),
          review: settings(5),
          reviewFacts: { trustedSince: T0.subtract({ hours: 720 }) },
          bucket: 999,
        });
        await old.submit.execute(contextOf('seller'), { offerId: old.offerId });
        expect(rows(old)).toEqual([]);
      });

      it('doubles for the seller this very submit makes Trusted (stampTrust)', async () => {
        const r = rig({
          offer: draft(),
          review: settings(5),
          reviewFacts: { stampTrust: true },
          bucket: 999,
        });
        await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
        expect(rows(r)[0]).toMatchObject({ samplePercent: 10, sampleDoubled: true });
      });

      it('draws nothing for a queued Offer and audits sampled null', async () => {
        const r = rig({
          offer: draft(),
          review: settings(100),
          reviewFacts: { probation: true },
          bucket: 0,
        });
        const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
        expect(outcome).toEqual({ ok: true, value: { published: false } });
        expect([r.sampler.asked, rows(r)]).toEqual([[], []]);
        expect(r.audits[0]).toEqual(
          expect.objectContaining({
            after: expect.objectContaining({ outcome: 'queued', sampled: null }) as unknown,
          }),
        );
      });
    });

    it('queues the Offer with its reasons when the policy finds any (R1, R2)', async () => {
      const r = rig({
        offer: draft(),
        review: { mode: 'risk-based', certificateBadges: 'review', emergencyStop: false },
        reviewFacts: { probation: true },
      });
      const outcome = await r.submit.execute(contextOf('seller'), {
        offerId: r.offerId,
        requestedTags: [typeCode],
      });
      expect(outcome).toEqual({ ok: true, value: { published: false } });
      expect(r.current()!.state.status).toBe('pending-first-publish');
      expect(r.referrals[0]!.reasons).toEqual(['probation', 'certificate-badge']);
      expect(r.audits[0]).toEqual(
        expect.objectContaining({
          after: expect.objectContaining({
            outcome: 'queued',
            reasons: ['probation', 'certificate-badge'],
          }) as unknown,
        }),
      );
      expect(r.outbox.types).not.toContain('catalog.offer-published.v1');
    });

    it.each([
      ['handling (R3)', { handling: 'FRESH' as const }, ['handling']],
      ['contact text (R5)', { description: { 'en-AU': 'Call 0412 345 678' } }, ['contact-text']],
    ])('queues an Offer for %s with only that reason', async (_name, overrides, reasons) => {
      const r = rig({ offer: offerState({ ...draft(), ...overrides }) });
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome).toEqual({ ok: true, value: { published: false } });
      expect(r.current()!.state.status).toBe('pending-first-publish');
      expect(r.referrals[0]!.reasons).toEqual(reasons);
      expect(r.outbox.types).not.toContain('catalog.offer-published.v1');
    });

    it('queues with full-review, sensitive-category and the seller or category stop (slice 4)', async () => {
      const r = rig({
        offer: draft(),
        reviewFacts: { fullReview: true, sensitiveCategory: true, emergencyStop: true },
      });
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome).toEqual({ ok: true, value: { published: false } });
      expect(r.referrals[0]!.reasons).toEqual([
        'emergency-stop',
        'full-review',
        'sensitive-category',
      ]);
    });

    it('stamps Trusted in the submit unit when N was lowered under the count (slice 4)', async () => {
      const r = rig({ offer: draft(), reviewFacts: { stampTrust: true, probationOffers: 1 } });
      // One approved product in epoch 1; N was lowered to 1.
      await r.probationStandings.lock(market, sellerId, T0);
      await r.probationStandings.credit(market, {
        sellerId,
        epoch: 1,
        productId: ids.next<'Product'>(),
        offerId: ids.next<'Offer'>(),
        creditedAt: T0,
      });
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome).toEqual({ ok: true, value: { published: true } });
      const [standing] = [...r.probationStandings.rows.values()];
      expect(standing?.trustedAt).not.toBeNull();
    });

    it('stamps nothing while N is 0, even when asked (Hassan S2)', async () => {
      const r = rig({ offer: draft(), reviewFacts: { stampTrust: true, probationOffers: 0 } });
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome).toEqual({ ok: true, value: { published: true } });
      const [standing] = [...r.probationStandings.rows.values()];
      expect(standing?.trustedAt ?? null).toBeNull();
    });

    it('judges a first publication in mode all when the facts are degraded, even in mode off (Hassan M1)', async () => {
      const r = rig({
        offer: draft(),
        review: { mode: 'off', certificateBadges: 'automatic', emergencyStop: false },
        reviewFacts: { degraded: true },
      });
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome).toEqual({ ok: true, value: { published: false } });
      expect(r.current()!.state.status).toBe('pending-first-publish');
      // No stop is invented: the safe mode's own reason.
      expect(r.referrals[0]!.reasons).toEqual(['review-all']);
      expect(r.outbox.types).not.toContain('catalog.offer-published.v1');
    });

    it('publishes in mode off when the facts were read, and an auto-publish credits nothing (Sajad G1)', async () => {
      const r = rig({
        offer: draft(),
        review: { mode: 'off', certificateBadges: 'automatic', emergencyStop: false },
      });
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome).toEqual({ ok: true, value: { published: true } });
      // Only an admin's approval counts toward probation.
      expect(r.probationStandings.credits).toEqual([]);
      expect(r.probationStandings.rows.size).toBe(0);
    });

    it('touches no standing when the facts do not ask for a stamp', async () => {
      const r = rig({ offer: draft() });
      await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(r.probationStandings.locks).toBe(0);
    });

    it('never publishes when the review inputs fail, and writes nothing', async () => {
      const r = rig({ offer: draft(), reviewInputsFail: true });
      await expect(r.submit.execute(contextOf('seller'), { offerId: r.offerId })).rejects.toThrow();
      expect(r.saved).toHaveLength(0);
      expect(r.referrals).toHaveLength(0);
      expect(r.outbox.types).toEqual([]);
    });

    it('announces nothing when the decision cannot be stored (one unit with the save)', async () => {
      const r = rig({ offer: draft(), referralFails: true });
      await expect(r.submit.execute(contextOf('seller'), { offerId: r.offerId })).rejects.toThrow();
      expect(r.audits).toHaveLength(0);
      expect(r.outbox.types).toEqual([]);
    });

    it('queues even a clean Offer of a trusted seller while the Market emergency stop is on (R0)', async () => {
      const r = rig({
        offer: draft(),
        review: { mode: 'off', certificateBadges: 'automatic', emergencyStop: true },
      });
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome).toEqual({ ok: true, value: { published: false } });
      expect(r.referrals[0]!.reasons).toEqual(['emergency-stop']);
    });

    it('adds the Market emergency stop to the reasons in modes all and risk-based too (R0)', async () => {
      for (const mode of ['all', 'risk-based'] as const) {
        const r = rig({
          offer: draft(),
          review: { mode, certificateBadges: 'automatic', emergencyStop: true },
          reviewFacts: { probation: true },
        });
        const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
        expect(outcome).toEqual({ ok: true, value: { published: false } });
        expect(r.referrals[0]!.reasons).toEqual(['emergency-stop', 'probation']);
      }
    });

    it('queues everything in mode all, and nothing but an emergency stop in mode off', async () => {
      const all = rig({
        offer: draft(),
        review: { mode: 'all', certificateBadges: 'automatic', emergencyStop: false },
      });
      expect(await all.submit.execute(contextOf('seller'), { offerId: all.offerId })).toEqual({
        ok: true,
        value: { published: false },
      });
      expect(all.referrals[0]!.reasons).toEqual(['review-all']);
      const off = rig({
        offer: draft(),
        review: { mode: 'off', certificateBadges: 'review', emergencyStop: false },
        reviewFacts: { probation: true, emergencyStop: true },
      });
      await off.submit.execute(contextOf('seller'), { offerId: off.offerId });
      expect(off.referrals[0]!.reasons).toEqual(['emergency-stop']);
    });

    it('refuses a submit under a paused product, which stays published (Hassan L-583-1)', async () => {
      const r = rig({ offer: draft(), paused: true });
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome).toEqual({ ok: false, error: { code: 'offer.product-not-published' } });
      expect(r.saved).toHaveLength(0);
    });

    it('refuses the whole submit when a requested type is not allowed', async () => {
      const r = rig({
        offer: draft(),
        decide: (query) => refusedDecision(query, 'no-certificate'),
      });
      expect(
        await r.submit.execute(contextOf('seller'), {
          offerId: r.offerId,
          requestedTags: [typeCode],
        }),
      ).toEqual({
        ok: false,
        error: {
          code: 'claim.requested-tag-not-allowed',
          tags: [{ typeCode, reason: 'no-certificate' }],
        },
      });
    });

    it('suspends a kept tag that is no longer allowed and still submits', async () => {
      const r = rig({
        offer: draft(),
        tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0)],
        decide: (query) => refusedDecision(query, 'certificate-expired'),
      });
      const outcome = await r.submit.execute(contextOf('seller'), { offerId: r.offerId });
      expect(outcome.ok).toBe(true);
      expect(r.current()!.tags[0]).toMatchObject({
        status: 'suspended',
        lastReasonCode: 'certificate-expired',
      });
      expect(r.outbox.types).toContain('catalog.offer-tag-suspended.v1');
    });

    it('refuses an unknown type and a malformed list before any read', async () => {
      const r = rig({ offer: draft() });
      expect(
        await r.submit.execute(contextOf('seller'), {
          offerId: r.offerId,
          requestedTags: ['nope-type'],
        }),
      ).toEqual({ ok: false, error: { code: 'tag.type-unknown' } });
      expect(
        await r.submit.execute(contextOf('seller'), {
          offerId: r.offerId,
          requestedTags: typeCode,
        }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'requestedTags', code: 'type' }] },
      });
      expect(r.saved).toHaveLength(0);
    });
  });

  describe('serialisation with revision publication (Hassan M1, M2)', () => {
    const draft = () =>
      offerState({ status: 'draft', listed: false, submittedAt: null, firstPublishedAt: null });

    it('add-tag asks again when the product moved between the ask and the write', async () => {
      const r = rig();
      r.claims.onPublishedRead = (read, fake) => {
        if (read === 2) fake.productVersion += 1;
      };
      const outcome = await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode });
      expect(outcome.ok).toBe(true);
      expect(r.evaluator.calls).toHaveLength(2);
      expect(r.saved).toHaveLength(1);
    });

    it('submit judges against the facts read in its own unit: a revision published every time is conflict.retry', async () => {
      const r = rig({ offer: draft() });
      r.claims.onPublishedRead = (read, fake) => {
        fake.productVersion = read;
      };
      expect(
        await r.submit.execute(contextOf('seller'), {
          offerId: r.offerId,
          requestedTags: [typeCode],
        }),
      ).toEqual({ ok: false, error: { code: 'conflict.retry' } });
      expect(r.evaluator.calls).toHaveLength(3);
      expect(r.saved).toHaveLength(0);
    });

    it('submit never activates on decisions about a revision other than the one read in the unit (M2)', async () => {
      const r = rig({ offer: draft() });
      r.claims.onPublishedRead = (read, fake) => {
        // Same product version, another published revision on every in-unit read.
        if (read % 2 === 0 && fake.published !== null) {
          fake.published = { ...fake.published, productRevisionId: ids.next<'ProductRevision'>() };
        }
      };
      expect(
        await r.submit.execute(contextOf('seller'), {
          offerId: r.offerId,
          requestedTags: [typeCode],
        }),
      ).toEqual({ ok: false, error: { code: 'conflict.retry' } });
      expect(r.saved).toHaveLength(0);
    });

    it('answers claim.check-unavailable, not a fault, when the category paths cannot be built (M3)', async () => {
      const r = rig();
      r.claims.onPublishedRead = () => {
        throw new CategoryPathsUnavailableError('unknown');
      };
      expect(await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode })).toEqual({
        ok: false,
        error: { code: 'claim.check-unavailable' },
      });
      const s = rig({ offer: draft() });
      s.claims.onPublishedRead = () => {
        throw new CategoryPathsUnavailableError('unknown');
      };
      expect(
        await s.submit.execute(contextOf('seller'), {
          offerId: s.offerId,
          requestedTags: [typeCode],
        }),
      ).toEqual({ ok: false, error: { code: 'claim.check-unavailable' } });
    });

    it('never faults when every answer is input-invalid (I3)', async () => {
      const invalid = (q: TagClaimQuery) => ({
        ...refusedDecision(q, 'input-invalid'),
        inputs: null,
      });
      const r = rig({ decide: invalid });
      expect(await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode })).toEqual({
        ok: false,
        error: { code: 'claim.tag-not-allowed', tags: [{ typeCode, reason: 'input-invalid' }] },
      });
      const kept = rig({
        offer: draft(),
        tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0)],
        decide: invalid,
      });
      const submitted = await kept.submit.execute(contextOf('seller'), { offerId: kept.offerId });
      expect(submitted.ok).toBe(true);
      expect(kept.current()!.tags[0]).toMatchObject({
        status: 'suspended',
        lastReasonCode: 'input-invalid',
      });
    });
  });

  describe('own-offer.remove-suspended-tag ("sell without this badge", design 5.3; AC 19)', () => {
    const suspendedTag = () =>
      activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0, {
        status: 'suspended',
        badge: null,
        lastReasonCode: 'certificate-revoked',
        changeSeq: 2,
      });

    it('removes the suspended tag on an explicit confirmation and lists the Offer again', async () => {
      const r = rig({
        offer: offerState({ offSaleCauses: ['tag-suspended'], listed: false }),
        tags: [suspendedTag()],
      });
      expect(
        await r.sellWithoutBadge.execute(contextOf('seller'), {
          offerId: r.offerId,
          typeCode,
          confirmSellWithoutBadge: true,
        }),
      ).toEqual({ ok: true, value: {} });
      expect(r.evaluator.calls).toHaveLength(0);
      expect(r.saved[0]!.tags[0]).toMatchObject({
        status: 'removed',
        removedByKind: 'seller',
        lastChangeCause: 'seller-remove-suspended',
      });
      expect(r.saved[0]!.state).toMatchObject({ offSaleCauses: [], listed: true });
      expect(r.outbox.types).toEqual([
        'catalog.offer-tag-removed.v1',
        'catalog.offer-listing-changed.v1',
      ]);
    });

    it('requires the literal confirmation, and refuses an active tag', async () => {
      const r = rig({ tags: [suspendedTag()] });
      for (const confirmSellWithoutBadge of [undefined, false, 'true', 1]) {
        expect(
          await r.sellWithoutBadge.execute(contextOf('seller'), {
            offerId: r.offerId,
            typeCode,
            confirmSellWithoutBadge,
          }),
        ).toEqual({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: 'confirmSellWithoutBadge', code: 'required' }],
          },
        });
      }
      const active = rig({
        tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0)],
      });
      expect(
        await active.sellWithoutBadge.execute(contextOf('seller'), {
          offerId: active.offerId,
          typeCode,
          confirmSellWithoutBadge: true,
        }),
      ).toEqual({ ok: false, error: { code: 'tag.not-suspended' } });
      expect(r.saved).toHaveLength(0);
      expect(active.saved).toHaveLength(0);
    });

    it('refuses an acting-as session, an admin and another seller’s Offer (AC 19)', async () => {
      const r = rig({ tags: [suspendedTag()] });
      const input = { offerId: r.offerId, typeCode, confirmSellWithoutBadge: true };
      expect(await r.sellWithoutBadge.execute(actingAs(), input)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await r.sellWithoutBadge.execute(contextOf('admin'), input)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      const other = rig({
        offer: offerState({ sellerId: ids.next<'Seller'>() }),
        tags: [suspendedTag()],
      });
      expect(
        await other.sellWithoutBadge.execute(contextOf('seller'), {
          ...input,
          offerId: other.offerId,
        }),
      ).toEqual({ ok: false, error: { code: 'offer.not-found' } });
      expect(r.saved).toHaveLength(0);
      expect(other.saved).toHaveLength(0);
    });
  });

  describe('acting-as sessions (Hassan L1)', () => {
    it('refuses add-tag, remove-tag and a submit with requestedTags; a plain submit is not a tag write', async () => {
      const r = rig({ tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0)] });
      expect(await r.add.execute(actingAs(), { offerId: r.offerId, typeCode })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await r.remove.execute(actingAs(), { offerId: r.offerId, typeCode })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      const d = rig({
        offer: offerState({
          status: 'draft',
          listed: false,
          submittedAt: null,
          firstPublishedAt: null,
        }),
      });
      expect(
        await d.submit.execute(actingAs(), { offerId: d.offerId, requestedTags: [typeCode] }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(r.saved).toHaveLength(0);
      expect(d.saved).toHaveLength(0);
      expect(r.evaluator.calls).toHaveLength(0);
    });
  });
});
