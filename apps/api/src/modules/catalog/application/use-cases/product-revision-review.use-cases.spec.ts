import {
  FakeClaimEvaluator,
  FixedFactsClaimQueryBuilder,
  activeTagState,
  allowedDecision,
  refusedDecision,
} from '../../../../../test/support/catalog-tag-fakes';
import { Temporal } from '@mondapac/shared-kernel';
import type {
  CallContext,
  ContentHash,
  MarketContext,
  MarketId,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
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
import type { OfferTagState, TagClaimQuery, TagDecision } from '../../domain/offer-tag';
import { Product, type ProductState } from '../../domain/product';
import type { StoredRevision } from '../../domain/stored-revision';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { ReviewDecision } from '../ports/product-revision.repository';
import { ProductRevisionApprove } from './product-revision-approve.use-case';
import { ProductRevisionRequestChanges } from './product-revision-request-changes.use-case';

// `product-revision.approve` and `.request-changes` in memory (catalog design 4.2 rows 3 and 5,
// 8.3a), on both Market fixtures. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-16T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-16T01:00:00Z');

describe.each(['AU', 'ZZ'] as const)('product revision review in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T1);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const productId = ids.next<'Product'>();
  const revisionId = ids.next<'ProductRevision'>();
  const variantId = ids.next<'Variant'>();
  const locale = realPolicy.locales(market).default;
  const taxCode = realPolicy.taxCategoryCodes(market)[0]!;

  const adminContext = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  const sellerContext = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );

  const productState = (overrides: Partial<ProductState> = {}): ProductState => ({
    id: productId,
    marketId: code as MarketId,
    scope: 'SELLER',
    ownerSellerId: sellerId,
    createdBySellerId: sellerId,
    typeCode: 'simple',
    variantModel: 'single',
    familyCode: 'default',
    productCode: 'P00000001',
    status: 'unpublished',
    discardedAt: null,
    ownBrand: false,
    lastChangedAt: T0,
    version: 4,
    createdAt: T0,
    variants: [
      { id: variantId, state: 'proposed', createdAt: T0, publishedAt: null, retiredAt: null },
    ],
    publishedRevisionId: null,
    pendingRevisionId: revisionId,
    pendingSubmittedAt: T0,
    ...overrides,
  });

  const revisionOf = (overrides: Partial<StoredRevision> = {}): StoredRevision => ({
    id: revisionId,
    productId,
    revisionNo: 1,
    kind: 'submission',
    baseRevisionId: null,
    revertedFromRevisionId: null,
    sensitive: true,
    sensitiveReasons: ['never-published', 'approval-required'],
    contentHash: 'sha256:aaaa' as ContentHash,
    authorKind: 'seller',
    authorAccountId: ids.next<'Account'>(),
    actingAdminAccountId: null,
    submittedAt: T0,
    content: {
      texts: { [locale]: { name: 'Dates', shortDescription: null, description: null } },
      categoryIds: [],
      taxCategoryCode: taxCode,
      attributeValues: {},
      variants: [{ variantId, position: 1, optionKey: '', optionValues: {}, labels: {} }],
      imageIds: [],
      schemaRef: { familyRevisionId: 'f', definitionRevisionIds: [] },
      contentSchemaVersion: 1,
    },
    ...overrides,
  });

  const ALL_CHECKS = [
    'photos-no-certification-mark',
    'category-fits',
    'tax-category-fits',
    'not-a-duplicate',
  ];

  function rig(
    options: {
      product?: ProductState | null;
      revision?: StoredRevision | null;
      eligible?: boolean;
      claim?: 'clean' | 'found' | 'down' | 'unmapped';
      hashDriftsInUnit?: boolean;
      saveThrows?: Error;
      /** The owner's Offer on the product with its open tags (slice 11 re-ask). */
      offer?: { state: OfferState; tags: OfferTagState[] };
      decide?: (query: TagClaimQuery) => TagDecision;
      unavailable?: boolean;
    } = {},
  ) {
    const state = options.product === undefined ? productState() : options.product;
    const revision = options.revision === undefined ? revisionOf() : options.revision;
    let findCalls = 0;
    const saved: Product[] = [];
    const decisions: ReviewDecision[] = [];
    const events: PendingEvent[] = [];
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const products = {
      // Like the real repository: a product of another Market is simply not found.
      findById: (m: MarketContext) =>
        Promise.resolve(
          state === null || state.marketId !== m.marketId ? null : Product.restore(state),
        ),
      save: (_m: MarketContext, product: Product) => {
        if (options.saveThrows !== undefined) return Promise.reject(options.saveThrows);
        saved.push(product);
        return Promise.resolve();
      },
    } as never;
    const revisions = {
      find: () => {
        findCalls += 1;
        // The guard read is the first call; every later one is inside the write unit.
        return Promise.resolve(
          options.hashDriftsInUnit === true && findCalls > 1 && revision !== null
            ? { ...revision, contentHash: 'sha256:bbbb' as ContentHash }
            : revision,
        );
      },
      recordDecision: (_m: MarketContext, decision: ReviewDecision) => {
        decisions.push(decision);
        return Promise.resolve();
      },
    } as never;
    const outbox = {
      append: (_c: CallContext, pending: readonly PendingEvent[]) => {
        events.push(...pending);
        return Promise.resolve();
      },
    };
    const check = {
      execute: (_c: CallContext, texts: readonly { field: string; locale: string }[]) => {
        if (options.claim === 'down') {
          return Promise.resolve({ ok: false, error: { code: 'access.unavailable' } });
        }
        return Promise.resolve({
          ok: true,
          value: texts.map((t) =>
            options.claim === 'unmapped'
              ? { code: 'claim-text.future-verdict', field: t.field, ref: null, locale: t.locale }
              : options.claim === 'found'
                ? {
                    code: 'claim-text.found',
                    field: t.field,
                    ref: null,
                    locale: t.locale,
                    hits: [],
                  }
                : { code: 'clean', field: t.field, ref: null, locale: t.locale },
          ),
        });
      },
    } as unknown as CheckClaimText;
    let offerRow = options.offer ?? null;
    const savedOffers: Offer[] = [];
    const evaluator = new FakeClaimEvaluator(
      options.decide ??
        (() => {
          throw new Error('no tag to ask');
        }),
      [],
    );
    evaluator.unavailable = options.unavailable ?? false;
    const approve = new ProductRevisionApprove(gate, {
      unitOfWork,
      products,
      revisions,
      eligibility: { isEligible: () => Promise.resolve(options.eligible ?? true) },
      check,
      policy: realPolicy,
      outbox,
      clock,
      offerFinder: {
        findOwnOnProduct: () =>
          Promise.resolve(offerRow === null ? null : Offer.restore(offerRow.state, offerRow.tags)),
      },
      offers: {
        save: (_m: MarketContext, offer: Offer) => {
          savedOffers.push(offer);
          offerRow = { state: offer.state, tags: [...offer.tags] };
          return Promise.resolve(null);
        },
      } as never,
      claims: new FixedFactsClaimQueryBuilder(null, {
        variantIds: [variantId],
        platformCategoryPaths: [],
      }),
      evaluator,
    });
    const requestChanges = new ProductRevisionRequestChanges(gate, {
      unitOfWork,
      products,
      revisions,
      outbox,
      clock,
    });
    return { approve, requestChanges, saved, decisions, events, savedOffers, evaluator };
  }

  const approveInput = (checks: string[] = ALL_CHECKS) => ({
    productId,
    revisionId,
    version: 4,
    checksConfirmed: checks,
  });
  const changesInput = (reasonCode = 'description-claim') => ({
    productId,
    revisionId,
    version: 4,
    reasonCode,
  });

  describe('approve re-asks the owner Offer tags before the pointer moves (5.1a point 3)', () => {
    const certificate = {
      certificateId: ids.next(),
      versionId: ids.next(),
      typeRevisionId: ids.next(),
    };
    const pendingOffer = (typeCode: string) => {
      const state: OfferState = {
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
        status: 'pending-first-publish',
        offSaleCauses: [],
        listed: false,
        submittedAt: T0,
        firstPublishedAt: null,
        deletedAt: null,
        version: 2,
        createdAt: T0,
      };
      const tag = activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0, {
        status: 'pending-publish',
        badge: null,
        copyRevisionId: revisionId,
        copyRevisionPublished: false,
        lastChangeCause: 'revision-submit',
      });
      return { state, tags: [tag] };
    };
    const typeCode = code === 'AU' ? 'halal' : 'zz-cert';

    it('makes a pending-publish tag active only from the fresh allowed answer, in the publish unit', async () => {
      const r = rig({
        offer: pendingOffer(typeCode),
        decide: (q) => allowedDecision(q, certificate),
      });
      expect(await r.approve.execute(adminContext(), approveInput())).toEqual({
        ok: true,
        value: {},
      });
      expect(r.evaluator.calls).toHaveLength(1);
      expect(r.evaluator.calls[0]![0]).toMatchObject({
        productRevisionId: revisionId,
        variantId,
        typeCode,
      });
      expect(r.saved).toHaveLength(1);
      expect(r.savedOffers).toHaveLength(1);
      expect(r.savedOffers[0]!.tags[0]).toMatchObject({
        status: 'active',
        copyRevisionId: revisionId,
        copyRevisionPublished: true,
        lastChangeCause: 'revision-publish',
      });
      expect(r.savedOffers[0]!.tags[0]!.badge).not.toBeNull();
      expect(r.events.map((e) => e.type)).toEqual([
        'catalog.product-revision-published.v1',
        'catalog.offer-tag-added.v1',
      ]);
    });

    it('suspends a pending-publish tag refused at publication; the product is still published', async () => {
      const r = rig({
        offer: pendingOffer(typeCode),
        decide: (q) => refusedDecision(q, 'no-valid-seller-certificate'),
      });
      expect(await r.approve.execute(adminContext(), approveInput())).toMatchObject({ ok: true });
      expect(r.saved[0]!.state.publishedRevisionId).toBe(revisionId);
      expect(r.savedOffers[0]!.tags[0]).toMatchObject({
        status: 'suspended',
        badge: null,
        copyRevisionPublished: true,
      });
      expect(r.savedOffers[0]!.state.offSaleCauses).toEqual(['tag-suspended']);
    });

    it('fails closed when the ask is unanswered: nothing published, nothing stored', async () => {
      const r = rig({ offer: pendingOffer(typeCode), unavailable: true });
      expect(await r.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'claim.check-unavailable' },
      });
      expect(r.saved).toEqual([]);
      expect(r.decisions).toEqual([]);
      expect(r.savedOffers).toEqual([]);
    });
  });

  describe('approve', () => {
    it('publishes the pending revision: pointer moves, variant published, decision and event stored', async () => {
      const r = rig();
      const outcome = await r.approve.execute(adminContext(), approveInput());

      expect(outcome).toEqual({ ok: true, value: {} });
      expect(r.saved).toHaveLength(1);
      expect(r.saved[0]!.state).toMatchObject({
        status: 'published',
        publishedRevisionId: revisionId,
        pendingRevisionId: null,
        pendingSubmittedAt: null,
      });
      expect(r.saved[0]!.state.variants[0]).toMatchObject({ state: 'published' });
      expect(r.decisions).toHaveLength(1);
      expect(r.decisions[0]).toMatchObject({
        revisionId,
        outcome: 'published',
        reasonCode: null,
        productVersion: 4,
        decidedAt: T1,
      });
      expect(r.decisions[0]!.requiredChecks).toEqual(ALL_CHECKS);
      expect(r.decisions[0]!.confirmedChecks).toEqual(ALL_CHECKS);
      expect(r.events.map((e) => e.type)).toEqual(['catalog.product-revision-published.v1']);
    });

    it('needs no check for a change that requires none', async () => {
      const published = ids.next<'ProductRevision'>();
      const r = rig({
        product: productState({
          status: 'published',
          publishedRevisionId: published,
          variants: [
            { id: variantId, state: 'published', createdAt: T0, publishedAt: T0, retiredAt: null },
          ],
        }),
        revision: revisionOf({ baseRevisionId: published, sensitiveReasons: ['name'] }),
      });
      const outcome = await r.approve.execute(adminContext(), approveInput([]));
      expect(outcome).toEqual({ ok: true, value: {} });
      expect(r.saved[0]!.state).toMatchObject({
        publishedRevisionId: revisionId,
        pendingRevisionId: null,
      });
      expect(r.decisions[0]).toMatchObject({ requiredChecks: [], confirmedChecks: [] });
    });

    it('refuses with revision.base-changed when the published revision moved after the submit', async () => {
      const r = rig({
        product: productState({
          status: 'published',
          publishedRevisionId: ids.next<'ProductRevision'>(),
        }),
        revision: revisionOf({ baseRevisionId: null, sensitiveReasons: ['name'] }),
      });
      expect(await r.approve.execute(adminContext(), approveInput([]))).toEqual({
        ok: false,
        error: { code: 'revision.base-changed' },
      });
      expect(r.saved).toHaveLength(0);
      expect(r.decisions).toHaveLength(0);
    });

    it('refuses with the missing checks listed and stores nothing', async () => {
      const r = rig();
      const outcome = await r.approve.execute(adminContext(), approveInput(['category-fits']));

      expect(outcome).toEqual({
        ok: false,
        error: {
          code: 'review.checks-missing',
          issues: [
            { path: 'checksConfirmed', code: 'photos-no-certification-mark' },
            { path: 'checksConfirmed', code: 'tax-category-fits' },
            { path: 'checksConfirmed', code: 'not-a-duplicate' },
          ],
        },
      });
      expect(r.saved).toHaveLength(0);
      expect(r.decisions).toHaveLength(0);
      expect(r.events).toHaveLength(0);
    });

    it('refuses a stale version and a revision that is not the pending one', async () => {
      const stale = rig({ product: productState({ version: 5 }) });
      expect(await stale.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      const other = rig({ product: productState({ pendingRevisionId: ids.next() }) });
      expect(await other.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'review.not-current-revision' },
      });
      const none = rig({
        product: productState({ pendingRevisionId: null, pendingSubmittedAt: null }),
      });
      expect(await none.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'review.not-current-revision' },
      });
      for (const r of [stale, other, none]) {
        expect(r.saved).toHaveLength(0);
        expect(r.decisions).toHaveLength(0);
      }
    });

    it('answers product.not-found for an unknown product and a PLATFORM product', async () => {
      const unknown = rig({ product: null });
      const platform = rig({
        product: productState({ scope: 'PLATFORM', ownerSellerId: null, createdBySellerId: null }),
      });
      for (const r of [unknown, platform]) {
        expect(await r.approve.execute(adminContext(), approveInput())).toEqual({
          ok: false,
          error: { code: 'product.not-found' },
        });
        expect(r.saved).toHaveLength(0);
      }
    });

    it('refuses a seller who may no longer sell, storing nothing', async () => {
      const r = rig({ eligible: false });
      expect(await r.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'seller.not-eligible' },
      });
      expect(r.saved).toHaveLength(0);
    });

    it('re-checks the claim text: a hit refuses with the fields, an unavailable matcher fails closed', async () => {
      const found = rig({ claim: 'found' });
      const outcome = await found.approve.execute(adminContext(), approveInput());
      expect(outcome).toMatchObject({ ok: false, error: { code: 'claim-text.refused' } });
      const down = rig({ claim: 'down' });
      expect(await down.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      for (const r of [found, down]) {
        expect(r.saved).toHaveLength(0);
        expect(r.decisions).toHaveLength(0);
      }
    });

    it('fails closed on a verdict that is neither clean nor mapped to a refusal', async () => {
      const r = rig({ claim: 'unmapped' });
      expect(await r.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      expect(r.saved).toHaveLength(0);
      expect(r.decisions).toHaveLength(0);
      expect(r.events).toHaveLength(0);
    });

    it('refuses with conflict.stale when the content hash changed inside the write unit', async () => {
      const r = rig({ hashDriftsInUnit: true });
      expect(await r.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(r.saved).toHaveLength(0);
      expect(r.decisions).toHaveLength(0);
      expect(r.events).toHaveLength(0);
    });

    it('answers product.not-found for a product of another Market, storing nothing', async () => {
      const foreign = (code === 'AU' ? 'ZZ' : 'AU') as MarketId;
      const r = rig({ product: productState({ marketId: foreign }) });
      expect(await r.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'product.not-found' },
      });
      expect(r.saved).toHaveLength(0);
      expect(r.decisions).toHaveLength(0);
      expect(r.events).toHaveLength(0);
    });

    it('answers conflict.stale when the save loses a race, announcing nothing', async () => {
      const r = rig({ saveThrows: new StaleAggregateError('product', productId) });
      expect(await r.approve.execute(adminContext(), approveInput())).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(r.decisions).toHaveLength(0);
      expect(r.events).toHaveLength(0);
    });

    it('refuses a malformed request: unknown key, bad ids, bad version, unknown or repeated check', async () => {
      const r = rig();
      const bad = [
        { ...approveInput(), extra: 1 },
        { ...approveInput(), productId: 'nope' },
        { ...approveInput(), revisionId: 'nope' },
        { ...approveInput(), version: '4' },
        { ...approveInput(), version: 0 },
        approveInput(['made-up']),
        approveInput(['category-fits', 'category-fits']),
        { productId, revisionId, version: 4 },
        null,
      ];
      for (const input of bad) {
        const outcome = await r.approve.execute(adminContext(), input as never);
        expect(outcome).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      }
      expect(r.saved).toHaveLength(0);
    });

    it('refuses a seller or an anonymous caller', async () => {
      const r = rig();
      expect(await r.approve.execute(sellerContext(), approveInput())).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(r.saved).toHaveLength(0);
    });
  });

  describe('request changes', () => {
    it('closes the revision: pointer cleared, decision with the reason code, event with the code', async () => {
      const r = rig();
      const outcome = await r.requestChanges.execute(adminContext(), changesInput());

      expect(outcome).toEqual({ ok: true, value: {} });
      expect(r.saved[0]!.state).toMatchObject({
        status: 'unpublished',
        publishedRevisionId: null,
        pendingRevisionId: null,
      });
      expect(r.decisions).toEqual([
        expect.objectContaining({
          revisionId,
          outcome: 'changes-requested',
          reasonCode: 'description-claim',
          confirmedChecks: [],
          productVersion: 4,
        }),
      ]);
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toMatchObject({
        type: 'catalog.product-revision-changes-requested.v1',
        payload: { productId, revisionId, reasonCode: 'description-claim', scope: 'seller' },
      });
    });

    it('takes only a reason of the Market list, never free text', async () => {
      const r = rig();
      for (const reasonCode of ['free text', '', 'OTHER']) {
        expect(await r.requestChanges.execute(adminContext(), changesInput(reasonCode))).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'unknown' }] },
        });
      }
      expect(
        await r.requestChanges.execute(adminContext(), { ...changesInput(), note: 'x' } as never),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(r.saved).toHaveLength(0);
    });

    it('refuses a stale version, another pending revision and an unknown product', async () => {
      const cases = [
        [rig({ product: productState({ version: 9 }) }), 'conflict.stale'],
        [
          rig({ product: productState({ pendingRevisionId: ids.next() }) }),
          'review.not-current-revision',
        ],
        [rig({ product: null }), 'product.not-found'],
      ] as const;
      for (const [r, expected] of cases) {
        expect(await r.requestChanges.execute(adminContext(), changesInput())).toEqual({
          ok: false,
          error: { code: expected },
        });
        expect(r.saved).toHaveLength(0);
        expect(r.decisions).toHaveLength(0);
      }
    });

    it('answers conflict.stale when the save loses a race', async () => {
      const r = rig({ saveThrows: new StaleAggregateError('product', productId) });
      expect(await r.requestChanges.execute(adminContext(), changesInput())).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(r.decisions).toHaveLength(0);
    });

    it('answers product.not-found for a product of another Market, storing nothing', async () => {
      const foreign = (code === 'AU' ? 'ZZ' : 'AU') as MarketId;
      const r = rig({ product: productState({ marketId: foreign }) });
      expect(await r.requestChanges.execute(adminContext(), changesInput())).toEqual({
        ok: false,
        error: { code: 'product.not-found' },
      });
      expect(r.saved).toHaveLength(0);
      expect(r.decisions).toHaveLength(0);
      expect(r.events).toHaveLength(0);
    });

    it('refuses a seller caller', async () => {
      const r = rig();
      expect(await r.requestChanges.execute(sellerContext(), changesInput())).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });
});
