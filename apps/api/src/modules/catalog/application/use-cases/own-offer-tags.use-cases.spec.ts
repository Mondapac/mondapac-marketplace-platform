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
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import { OwnOfferAddTag } from './own-offer-add-tag.use-case';
import { OwnOfferRemoveTag } from './own-offer-remove-tag.use-case';
import { OwnOfferSubmit } from './own-offer-submit.use-case';

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
      decide?: (query: TagClaimQuery) => ReturnType<typeof allowedDecision>;
      unavailable?: boolean;
      /** Each read of the Offer after the first answers this version (another write landed). */
      laterVersion?: number;
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
    const facts = initial === null ? null : factsOf(initial.state);
    const claims = new FixedFactsClaimQueryBuilder(options.published === false ? null : facts);
    const offers: OfferRepository = {
      add: () => Promise.reject(new Error('unused')),
      listPendingReview: () => Promise.resolve([]),
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
    const products = {
      findById: (_m: MarketContext, id: Id<'Product'>) =>
        Promise.resolve({
          state: {
            id,
            status: options.published === false ? 'unpublished' : 'published',
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
    const submit = new OwnOfferSubmit(gate, {
      unitOfWork,
      offers,
      products,
      eligibility,
      allowedTypes: { allowedFor: () => Promise.resolve('all' as const) },
      check,
      policy: { approvalRequired: () => Promise.resolve(false) } as unknown as CatalogMarketPolicy,
      outbox,
      claims,
      evaluator,
      clock,
      ids,
    });
    return {
      add,
      remove,
      submit,
      saved,
      outbox,
      evaluator,
      claims,
      offerId: initial?.state.id ?? ids.next<'Offer'>(),
      current: () => current,
    };
  }

  describe('own-offer.add-tag', () => {
    it('writes the tag active with the badge of this request and announces it', async () => {
      const r = rig();
      const outcome = await r.add.execute(contextOf('seller'), { offerId: r.offerId, typeCode });
      expect(outcome).toEqual({ ok: true, value: { typeCode, status: 'active', basis: 'SELLER' } });
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
