import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
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
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { simpleProductType } from '../../domain/product-types/simple';
import type { StoredRevision } from '../../domain/stored-revision';
import { FreezeRevision } from '../revisions/freeze-revision.service';
import { SubmitProduct } from '../revisions/submit-product.service';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { AttributeRepository } from '../ports/attribute.repository';
import { Product } from '../../domain/product';
import type { WorkingCopy } from '../../domain/working-copy';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTextMatcher, ClaimTextToMatch } from '../ports/claim-text-matcher';
import { Offer, type OfferState } from '../../domain/offer';
import type { OfferTagState } from '../../domain/offer-tag';
import {
  FakeClaimEvaluator,
  FixedFactsClaimQueryBuilder,
  activeTagState,
  allowedDecision,
  refusedDecision,
} from '../../../../../test/support/catalog-tag-fakes';
import type { OfferAddRefusal, OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { OwnProductCreate } from './own-product-create.use-case';
import { OwnProductSubmit, type OwnProductSubmitInput } from './own-product-submit.use-case';
import type { AllowedProductTypes } from '../ports/allowed-product-types.reader';

// `own-product.create` and `own-product.submit` in memory (catalog design 4.2 row 1, 6; slice 6), on both Market
// fixtures: the freeze, the claim-text check over every text of the frozen content, the admin
// outcome (published at once), the stored revision, and the refusals that store nothing. The
// gate admits every authenticated actor; the declaration is checked by the CI list. The database
// behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

const FIXTURES = [
  { code: 'AU', locales: { default: 'en', supported: ['en', 'ar'] }, tax: 'GST' },
  { code: 'ZZ', locales: { default: 'zz', supported: ['zz', 'en'] }, tax: 'STD' },
] as const;
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const HIT = { typeCode: 'type-a', span: { fromToken: 0, toToken: 0 } };

describe.each(FIXTURES)(
  'own-product.create and own-product.submit in market $code',
  ({ code, locales, tax }) => {
    const market: MarketContext = testMarketContext(code, 'default');
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const locale = locales.default;

    const SELLER = ids.next<'Seller'>();
    const contextOf = (
      population: 'admin' | 'seller' | 'customer',
      sellerId: Id<'Seller'> = SELLER,
    ): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: population === 'seller' ? sellerId : null,
        }),
      );

    function newProduct(
      scope: 'SELLER' | 'PLATFORM' = 'SELLER',
      owner: Id<'Seller'> = SELLER,
    ): Product {
      const created = Product.create({
        id: ids.next<'Product'>(),
        marketId: code as MarketId,
        scope,
        sellerId: scope === 'SELLER' ? owner : null,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: 'P00000001',
        variantId: ids.next<'Variant'>(),
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      return Product.restore({ ...created.value.state, version: 1 });
    }

    const draft = (extra: Record<string, unknown> = {}): WorkingCopy['content'] => ({
      texts: { [locale]: { name: 'Dates', description: 'Sweet and soft' } },
      categoryIds: ['c1'],
      taxCategoryCode: tax,
      ...extra,
    });

    const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
    const certificateIds = {
      certificateId: ids.next(),
      versionId: ids.next(),
      typeRevisionId: ids.next(),
    };
    const offerOn =
      (overrides: Partial<OfferState> = {}) =>
      (productId: Id<'Product'>): OfferState => ({
        id: ids.next<'Offer'>(),
        marketId: code as MarketId,
        sellerId: SELLER,
        productId,
        sellerSku: 'SKU-1',
        conditionCode: 'new',
        description: {},
        handling: 'SEALED_ORIGINAL',
        attestationRecordedAt: null,
        attestationAccountId: null,
        status: 'draft',
        offSaleCauses: [],
        listed: false,
        submittedAt: null,
        firstPublishedAt: null,
        deletedAt: null,
        version: 1,
        createdAt: T0,
        ...overrides,
      });

    function rig(
      matcherOverride?: ClaimTextMatcher,
      options: {
        approvalThrows?: boolean;
        approvalRequired?: boolean;
        noSchema?: boolean;
        eligible?: boolean;
        allowed?: AllowedProductTypes | null;
        creationOn?: boolean | 'fault';
        reserve?: { code: 'request.throttled'; retryAfterSeconds: number } | null;
        gateOverride?: AuthorisationCheck;
        offerRefusal?: OfferAddRefusal;
        /** The seller's Offer on the product (by product id at seed time). */
        offer?: (productId: Id<'Product'>) => OfferState;
        offerTags?: OfferTagState[];
        refuse?: string;
        unavailable?: boolean;
        /** Called before each read of the seller's Offer; may change it (another write). */
        onOfferRead?: (read: number, state: OfferState) => OfferState;
      } = {},
    ) {
      const evaluator = new FakeClaimEvaluator(
        (query) =>
          options.refuse !== undefined
            ? refusedDecision(query, options.refuse)
            : allowedDecision(query, certificateIds),
        [typeCode],
      );
      evaluator.unavailable = options.unavailable ?? false;
      let ownOffer: { state: OfferState; tags: readonly OfferTagState[] } | null = null;
      const savedOffers: Offer[] = [];
      let offerReads = 0;
      const offerFinder = {
        findOwnOnProduct: (_m: MarketContext, sellerId: Id<'Seller'>, productId: Id<'Product'>) => {
          offerReads += 1;
          if (ownOffer !== null && options.onOfferRead !== undefined) {
            ownOffer = { ...ownOffer, state: options.onOfferRead(offerReads, ownOffer.state) };
          }
          return Promise.resolve(
            ownOffer !== null &&
              ownOffer.state.sellerId === sellerId &&
              ownOffer.state.productId === productId
              ? Offer.restore(ownOffer.state, ownOffer.tags)
              : null,
          );
        },
      };
      const claims = new FixedFactsClaimQueryBuilder(null, {
        variantIds: [],
        platformCategoryPaths: [],
      });
      const stored = new Map<string, Product>();
      const copies = new Map<string, WorkingCopy>();
      const revisions = new Map<string, StoredRevision>();
      const matched: ClaimTextToMatch[][] = [];
      const events: unknown[] = [];
      // Units do not nest and the real matcher opens its own: a call inside an open unit is a bug.
      let openUnits = 0;
      const matcher: ClaimTextMatcher = matcherOverride ?? {
        match: (_c, texts) => {
          if (openUnits > 0) throw new Error('the matcher was called inside an open unit');
          matched.push([...texts]);
          return Promise.resolve({
            ok: true as const,
            value: texts.map((item) => (item.text.includes('halal') ? [HIT] : [])),
          });
        },
      };
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
      const products: ProductRepository = {
        nextProductCode: () => Promise.resolve('P00000001'),
        add: () => Promise.resolve(),
        findById: (_m, id) => {
          const found = stored.get(id);
          return Promise.resolve(found === undefined ? null : Product.restore({ ...found.state }));
        },
        save: (_m, product) => {
          stored.set(product.state.id, Product.restore({ ...product.state }));
          return Promise.resolve();
        },
      };
      const workingCopies: WorkingCopyRepository = {
        find: (_m, id) => Promise.resolve(copies.get(id) ?? null),
        save: (_m, copy) => {
          copies.set(copy.productId, copy);
          return Promise.resolve();
        },
      };
      const revisionRepo: ProductRevisionRepository = {
        nextRevisionNo: (_m, productId) =>
          Promise.resolve(
            [...revisions.values()].filter((revision) => revision.productId === productId).length +
              1,
          ),
        add: (_m, revision) => {
          revisions.set(revision.id, revision);
          return Promise.resolve();
        },
        recordDecision: () => Promise.resolve(),
        latestChangeRequest: () => Promise.resolve(null),
        find: (_m, productId, id) => {
          const found = revisions.get(id);
          return Promise.resolve(found?.productId === productId ? found : null);
        },
      };
      const policy: CatalogMarketPolicy = {
        taxCategoryCodes: () => [tax],
        locales: () => ({ default: locales.default, supported: [...locales.supported] }),
        sensitiveChanges: () => ({
          platformCategories: true,
          taxCategory: true,
          name: true,
          primaryImage: true,
          anyImage: false,
          variantRemoved: true,
        }),
        maxVariantsPerProduct: () => 100,
        productTypes: () => ['simple', 'configurable'],
        defaultFamily: () => 'default',
        conditions: () => ['new'],
        sellFromCatalogue: () => Promise.resolve(true),
        sellerCanCreateProduct: () =>
          options.creationOn === 'fault'
            ? Promise.reject(new Error('config'))
            : Promise.resolve(options.creationOn ?? true),
        approvalRequired: () =>
          options.approvalThrows === true
            ? Promise.reject(new Error('config'))
            : Promise.resolve(options.approvalRequired ?? true),
      };
      const outbox: OutboxWriter = {
        append: (_c, list) => {
          events.push(...list);
          return Promise.resolve();
        },
      };
      const counterRepo: RateCounterRepository = {
        reserve: () => Promise.reject(new Error('submit spends no counter')),
        purgeStartedBefore: () => Promise.resolve(0),
      };
      const check = new CheckClaimText({
        unitOfWork,
        matcher,
        counters: counterRepo,
        counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
        policy,
        clock,
      });
      const attributes = {
        loadSchema: () =>
          Promise.resolve(
            options.noSchema === true
              ? null
              : {
                  schemaRef: {
                    familyCode: 'default',
                    familyRevisionId: 'fam-rev-1',
                    definitionRevisionIds: [],
                  },
                  fields: [
                    {
                      code: 'note',
                      dataType: 'text',
                      localizable: true,
                      required: false,
                      isVariantOption: false,
                      material: false,
                      claimChecked: true,
                      bounds: { maxLength: 50 },
                    },
                  ],
                },
          ),
      } as unknown as AttributeRepository;
      const freeze = new FreezeRevision({
        attributes,
        policy,
        handlerFor: (typeCode) => (typeCode === 'simple' ? simpleProductType : undefined),
      });
      const submit = new SubmitProduct({
        unitOfWork,
        products,
        workingCopies,
        revisions: revisionRepo,
        freeze,
        check,
        policy,
        outbox,
        clock,
        ids,
      });
      const eligibility = { isEligible: () => Promise.resolve(options.eligible ?? true) };
      const allowedTypes = {
        allowedFor: () => Promise.resolve(options.allowed === undefined ? 'all' : options.allowed),
      };
      const useCase = new OwnProductSubmit(
        options.gateOverride === undefined
          ? gate
          : createUseCaseGate(markets, options.gateOverride),
        {
          unitOfWork,
          products,
          submit,
          eligibility,
          allowedTypes,
          offerFinder,
          offers: {
            add: () => Promise.reject(new Error('unused')),
            findById: () => Promise.reject(new Error('unused')),
            listPendingReview: () => Promise.resolve([]),
            save: (_m, offer) => {
              if (openUnits === 0) throw new Error('the Offer is saved outside the submit unit');
              savedOffers.push(offer);
              ownOffer = {
                state: { ...offer.state },
                tags: offer.tags.filter((tag) => tag.status !== 'removed'),
              };
              return Promise.resolve(null);
            },
          },
          claims,
          evaluator,
          clock,
          ids,
        },
      );
      const added: Product[] = [];
      const createProducts: ProductRepository = {
        ...products,
        nextProductCode: () => Promise.resolve('P00000007'),
        add: (_m, product) => {
          added.push(product);
          return Promise.resolve();
        },
      };
      const addedOffers: Offer[] = [];
      const offers: OfferRepository = {
        add: (_m, offer) => {
          if (options.offerRefusal !== undefined) return Promise.resolve(options.offerRefusal);
          addedOffers.push(offer);
          return Promise.resolve(null);
        },
        findById: () => Promise.resolve(null),
        listPendingReview: () => Promise.resolve([]),
        save: () => Promise.reject(new Error('unused')),
      };
      const create = new OwnProductCreate(gate, {
        unitOfWork,
        products: createProducts,
        offers,
        check,
        attributes,
        eligibility,
        allowedTypes,
        save: { reserveSaves: () => Promise.resolve(options.reserve ?? null) },
        policy,
        productTypes: (typeCode) => (typeCode === 'simple' ? simpleProductType : undefined),
        outbox,
        clock,
        ids,
      });
      const seed = (product: Product, content: WorkingCopy['content'] | null = draft()) => {
        stored.set(product.state.id, product);
        if (options.offer !== undefined) {
          ownOffer = { state: options.offer(product.state.id), tags: options.offerTags ?? [] };
          claims.submitted = {
            variantIds: product.state.variants.map((variant) => variant.id),
            platformCategoryPaths: [],
          };
        }
        if (content !== null) {
          copies.set(product.state.id, {
            productId: product.state.id,
            content,
            contentSchemaVersion: 1,
            baseRevisionId: null,
            lastSavedAt: T0,
            lastSavedByAccountId: ids.next<'Account'>(),
          });
        }
      };
      return {
        useCase,
        create,
        added,
        addedOffers,
        stored,
        copies,
        revisions,
        matched,
        events,
        seed,
        evaluator,
        savedOffers,
        ownOffer: () => ownOffer,
      };
    }

    const request = (productId: string, replacePending = false): OwnProductSubmitInput => ({
      productId,
      replacePending,
    });

    it('publishes an own revision at once when the Market needs no approval', async () => {
      const r = rig(undefined, { approvalRequired: false });
      const product = newProduct();
      r.seed(product);
      const submitted = await r.useCase.execute(contextOf('seller'), request(product.state.id));
      expect(submitted.ok && submitted.value).toMatchObject({ revisionNo: 1, published: true });
      const revision = [...r.revisions.values()][0]!;
      expect(revision).toMatchObject({ authorKind: 'seller', kind: 'submission' });
      expect(r.stored.get(product.state.id)?.state.publishedRevisionId).toBe(revision.id);
    });

    it('keeps an own revision pending for review when the Market needs approval', async () => {
      const r = rig();
      const product = newProduct();
      r.seed(product);
      const submitted = await r.useCase.execute(contextOf('seller'), request(product.state.id));
      expect(submitted.ok && submitted.value).toMatchObject({ revisionNo: 1, published: false });
      const state = r.stored.get(product.state.id)!.state;
      expect(state.publishedRevisionId).toBeNull();
      expect(state.pendingRevisionId).toBe(submitted.ok ? submitted.value.revisionId : null);
      expect(state.status).toBe('unpublished');
    });

    it('asks for replacePending when a revision is already pending, then supersedes it', async () => {
      const r = rig();
      const product = newProduct();
      r.seed(product);
      await r.useCase.execute(contextOf('seller'), request(product.state.id));
      const refused = await r.useCase.execute(contextOf('seller'), request(product.state.id));
      expect(refused).toEqual({ ok: false, error: { code: 'revision.pending-exists' } });
      const replaced = await r.useCase.execute(
        contextOf('seller'),
        request(product.state.id, true),
      );
      expect(replaced.ok && replaced.value.revisionNo).toBe(2);
      expect(r.revisions.size).toBe(2);
    });

    it('answers another seller’s product, a PLATFORM product and an unknown id alike', async () => {
      const r = rig();
      const others = newProduct('SELLER', ids.next<'Seller'>());
      const platform = newProduct('PLATFORM');
      r.seed(others);
      r.seed(platform);
      const answers = [
        await r.useCase.execute(contextOf('seller'), request(others.state.id)),
        await r.useCase.execute(contextOf('seller'), request(platform.state.id)),
        await r.useCase.execute(contextOf('seller'), request(ids.next<'Product'>())),
      ];
      for (const answer of answers) {
        expect(answer).toEqual({ ok: false, error: { code: 'product.not-found' } });
      }
      expect(r.revisions.size).toBe(0);
    });

    it('refuses claim text in a stored draft and stores nothing', async () => {
      const r = rig();
      const product = newProduct();
      r.seed(
        product,
        draft({ texts: { [locale]: { name: 'Dates', description: 'halal dates' } } }),
      );
      const submitted = await r.useCase.execute(contextOf('seller'), request(product.state.id));
      expect(submitted.ok).toBe(false);
      expect(!submitted.ok && submitted.error.code).toBe('claim-text.refused');
      expect(r.revisions.size).toBe(0);
    });

    it('refuses a seller who may not sell, a type outside SEL-12 and an unreadable SEL-12', async () => {
      const product = newProduct();
      const notEligible = rig(undefined, { eligible: false });
      notEligible.seed(product);
      expect(
        await notEligible.useCase.execute(contextOf('seller'), request(product.state.id)),
      ).toEqual({
        ok: false,
        error: { code: 'seller.not-eligible' },
      });
      const restricted = rig(undefined, { allowed: new Set(['configurable']) });
      restricted.seed(product);
      expect(
        await restricted.useCase.execute(contextOf('seller'), request(product.state.id)),
      ).toEqual({
        ok: false,
        error: { code: 'type.not-allowed' },
      });
      const unreadable = rig(undefined, { allowed: null });
      unreadable.seed(product);
      expect(
        await unreadable.useCase.execute(contextOf('seller'), request(product.state.id)),
      ).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      for (const r of [notEligible, restricted, unreadable]) expect(r.revisions.size).toBe(0);
    });

    it('refuses an admin, a customer and a malformed request', async () => {
      const r = rig();
      const product = newProduct();
      r.seed(product);
      for (const population of ['admin', 'customer'] as const) {
        expect(await r.useCase.execute(contextOf(population), request(product.state.id))).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      const bad = await r.useCase.execute(contextOf('seller'), {
        productId: 'x',
        replacePending: false,
      });
      expect(bad).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'productId', code: 'format' }] },
      });
      expect(r.revisions.size).toBe(0);
    });

    describe('badge requests and the T4 check (design 5.1a)', () => {
      const withTags = (productId: string, tags: unknown, replacePending = false) => ({
        productId,
        replacePending,
        requestedTags: tags,
      });

      it('stores the requested tags as pending-publish, asked against the frozen revision', async () => {
        const r = rig(undefined, { offer: offerOn() });
        const product = newProduct();
        r.seed(product);
        const submitted = await r.useCase.execute(
          contextOf('seller'),
          withTags(product.state.id, [typeCode]),
        );
        expect(submitted.ok).toBe(true);
        const revisionId = submitted.ok ? submitted.value.revisionId : null;
        expect(r.revisions.has(revisionId!)).toBe(true);
        expect(r.evaluator.calls).toHaveLength(1);
        expect(r.evaluator.calls[0]!.map((q) => q.productRevisionId)).toEqual([revisionId]);
        const offer = r.ownOffer()!;
        expect(offer.tags).toEqual([
          expect.objectContaining({
            typeCode,
            status: 'pending-publish',
            badge: null,
            copyRevisionId: revisionId,
            copyRevisionPublished: false,
          }),
        ]);
        expect(offer.state.listed).toBe(false);
        expect(r.events.map((event) => (event as { type: string }).type)).not.toContain(
          'catalog.offer-tag-added.v1',
        );
      });

      it('refuses the whole submit when a requested type is not allowed, storing nothing', async () => {
        const r = rig(undefined, { offer: offerOn(), refuse: 'no-certificate' });
        const product = newProduct();
        r.seed(product);
        const submitted = await r.useCase.execute(
          contextOf('seller'),
          withTags(product.state.id, [typeCode]),
        );
        expect(submitted).toEqual({
          ok: false,
          error: {
            code: 'claim.requested-tag-not-allowed',
            tags: [{ typeCode, reason: 'no-certificate' }],
          },
        });
        expect(r.revisions.size).toBe(0);
        expect(r.savedOffers).toHaveLength(0);
      });

      it('refuses an unknown type before asking, and fails closed when the check is unavailable', async () => {
        const r = rig(undefined, { offer: offerOn() });
        const product = newProduct();
        r.seed(product);
        expect(
          await r.useCase.execute(contextOf('seller'), withTags(product.state.id, ['not-a-type'])),
        ).toEqual({ ok: false, error: { code: 'tag.type-unknown' } });
        expect(r.evaluator.calls).toHaveLength(0);
        const down = rig(undefined, { offer: offerOn(), unavailable: true });
        down.seed(product);
        expect(
          await down.useCase.execute(contextOf('seller'), withTags(product.state.id, [typeCode])),
        ).toEqual({ ok: false, error: { code: 'claim.check-unavailable' } });
        expect(down.revisions.size).toBe(0);
      });

      it('refuses requests without an Offer, without handling and in a malformed list', async () => {
        const product = newProduct();
        const none = rig();
        none.seed(product);
        expect(
          await none.useCase.execute(contextOf('seller'), withTags(product.state.id, [typeCode])),
        ).toEqual({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: 'requestedTags', code: 'no-offer' }],
          },
        });
        const noHandling = rig(undefined, { offer: offerOn({ handling: null }) });
        noHandling.seed(product);
        expect(
          await noHandling.useCase.execute(
            contextOf('seller'),
            withTags(product.state.id, [typeCode]),
          ),
        ).toEqual({ ok: false, error: { code: 'offer.handling-missing' } });
        for (const [tags, reason] of [
          ['halal', 'type'],
          [[typeCode, typeCode], 'duplicate'],
          [['Bad Code'], 'format'],
        ] as const) {
          expect(
            await none.useCase.execute(contextOf('seller'), withTags(product.state.id, tags)),
          ).toEqual({
            ok: false,
            error: { code: 'validation.failed', fields: [{ path: 'requestedTags', code: reason }] },
          });
        }
        expect(none.revisions.size + noHandling.revisions.size).toBe(0);
      });

      it('clears the pending set when a later first submit requests nothing', async () => {
        const r = rig(undefined, { offer: offerOn() });
        const product = newProduct();
        r.seed(product);
        expect(
          (await r.useCase.execute(contextOf('seller'), withTags(product.state.id, [typeCode]))).ok,
        ).toBe(true);
        const again = await r.useCase.execute(
          contextOf('seller'),
          withTags(product.state.id, undefined, true),
        );
        expect(again.ok).toBe(true);
        expect(r.ownOffer()!.tags).toEqual([]);
      });

      it('submits again when the Offer changed between the T4 ask and the submit unit (Hassan M1)', async () => {
        const r = rig(undefined, {
          approvalRequired: false,
          offer: offerOn({ status: 'published', listed: true, firstPublishedAt: T0 }),
          offerTags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0)],
          // Every read after the first publish sees a newer Offer version.
          onOfferRead: (read, state) =>
            read > 1 ? { ...state, version: state.version + 1 } : state,
        });
        const product = newProduct();
        r.seed(product);
        expect((await r.useCase.execute(contextOf('seller'), request(product.state.id))).ok).toBe(
          true,
        );
        // Each attempt's unit ends in an error, so the real unit of work stores none of it (this
        // in-memory unit does not roll back, so the stored revisions are not counted here).
        expect(await r.useCase.execute(contextOf('seller'), request(product.state.id))).toEqual({
          ok: false,
          error: { code: 'conflict.retry' },
        });
        expect(r.evaluator.calls.length).toBeGreaterThanOrEqual(3);
      });

      it('refuses requestedTags in an acting-as session (Hassan L1)', async () => {
        const r = rig(undefined, { offer: offerOn() });
        const product = newProduct();
        r.seed(product);
        const context = contextOf('seller');
        const actor = { ...context.actor, actingAs: { adminAccountId: ids.next() } };
        expect(
          await r.useCase.execute(
            { ...context, actor: actor },
            withTags(product.state.id, [typeCode]),
          ),
        ).toEqual({ ok: false, error: { code: 'access.denied' } });
        expect(r.revisions.size).toBe(0);
      });

      it('runs T4 on a published product: refuses a submit that would lose a tag, stores nothing on the Offer', async () => {
        const r = rig(undefined, {
          approvalRequired: false,
          offer: offerOn({ status: 'published', listed: true, firstPublishedAt: T0 }),
          offerTags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0)],
        });
        const product = newProduct();
        r.seed(product);
        expect((await r.useCase.execute(contextOf('seller'), request(product.state.id))).ok).toBe(
          true,
        );
        expect(r.evaluator.calls).toHaveLength(0);
        expect(
          await r.useCase.execute(contextOf('seller'), withTags(product.state.id, [typeCode])),
        ).toEqual({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: 'requestedTags', code: 'published' }],
          },
        });
        r.evaluator.decide = (query) => refusedDecision(query, 'category-not-covered');
        const revisionsBefore = r.revisions.size;
        expect(await r.useCase.execute(contextOf('seller'), request(product.state.id))).toEqual({
          ok: false,
          error: {
            code: 'claim.tags-would-be-lost',
            tags: [{ typeCode, reason: 'category-not-covered' }],
          },
        });
        expect(r.revisions.size).toBe(revisionsBefore);
        r.evaluator.decide = (query) => allowedDecision(query, certificateIds);
        expect((await r.useCase.execute(contextOf('seller'), request(product.state.id))).ok).toBe(
          true,
        );
        expect(r.savedOffers).toHaveLength(0);
        expect(r.ownOffer()!.tags[0]!.status).toBe('active');
      });
    });

    const FORM = {
      typeCode: 'simple',
      sellerSku: 'SKU-1',
      conditionCode: 'new',
      description: { [locale]: 'A plain description' },
    };

    describe('own-product.create', () => {
      it('creates a draft SELLER product owned by the actor’s seller', async () => {
        const r = rig();
        const created = await r.create.execute(contextOf('seller'), FORM);
        expect(created.ok && created.value.productCode).toBe('P00000007');
        expect(created.ok && created.value.variantIds).toHaveLength(1);
        expect(r.added).toHaveLength(1);
        expect(r.added[0]!.state).toMatchObject({
          scope: 'SELLER',
          ownerSellerId: SELLER,
          createdBySellerId: SELLER,
          status: 'draft',
          familyCode: 'default',
          marketId: code,
        });
        expect(r.added[0]!.pendingEvents.length).toBeGreaterThan(0);
        expect(created.ok && created.value.offerId).toBe(r.addedOffers[0]!.state.id);
        expect(r.addedOffers).toHaveLength(1);
        expect(r.addedOffers[0]!.state).toMatchObject({
          sellerId: SELLER,
          productId: r.added[0]!.state.id,
          sellerSku: 'SKU-1',
          status: 'draft',
        });
      });

      it('refuses a taken SKU and a bad Offer form, keeping neither product nor Offer', async () => {
        const taken = rig(undefined, { offerRefusal: 'offer.sku-taken' });
        expect(await taken.create.execute(contextOf('seller'), FORM)).toEqual({
          ok: false,
          error: { code: 'offer.sku-taken' },
        });
        const r = rig();
        const bad = await r.create.execute(contextOf('seller'), { ...FORM, conditionCode: 'nope' });
        expect(bad).toEqual({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: 'conditionCode', code: 'unknown' }],
          },
        });
        const extra = await r.create.execute(contextOf('seller'), {
          ...FORM,
          sellerId: 'x',
        } as typeof FORM);
        expect(extra.ok).toBe(false);
        expect(r.added).toHaveLength(0);
        expect(r.addedOffers).toHaveLength(0);
      });

      it('refuses in order: not eligible, setting off, unknown type, SEL-12, spent budget', async () => {
        const call = (options: Parameters<typeof rig>[1], typeCode = 'simple') => {
          const r = rig(undefined, options);
          return r.create
            .execute(contextOf('seller'), { ...FORM, typeCode })
            .then((result) => ({ result, r }));
        };
        expect((await call({ eligible: false, creationOn: false })).result).toEqual({
          ok: false,
          error: { code: 'seller.not-eligible' },
        });
        expect((await call({ creationOn: false })).result).toEqual({
          ok: false,
          error: { code: 'setting.product-creation-off' },
        });
        expect((await call({ creationOn: 'fault' })).result).toEqual({
          ok: false,
          error: { code: 'access.unavailable' },
        });
        expect((await call({}, 'hologram')).result).toEqual({
          ok: false,
          error: { code: 'product.type-not-offered' },
        });
        expect((await call({}, 'configurable')).result).toEqual({
          ok: false,
          error: { code: 'product.type-unknown' },
        });
        expect((await call({ allowed: new Set(['configurable']) })).result).toEqual({
          ok: false,
          error: { code: 'type.not-allowed' },
        });
        expect((await call({ allowed: null })).result).toEqual({
          ok: false,
          error: { code: 'access.unavailable' },
        });
        const throttled = await call({
          reserve: { code: 'request.throttled', retryAfterSeconds: 9 },
        });
        expect(throttled.result).toEqual({
          ok: false,
          error: { code: 'request.throttled', retryAfterSeconds: 9 },
        });
        expect(throttled.r.added).toHaveLength(0);
      });

      it('refuses an admin and a customer, and a body that is not an object with a type', async () => {
        const r = rig();
        for (const population of ['admin', 'customer'] as const) {
          expect(await r.create.execute(contextOf(population), FORM)).toEqual({
            ok: false,
            error: { code: 'access.denied' },
          });
        }
        expect(await r.create.execute(contextOf('seller'), {} as typeof FORM)).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'typeCode', code: 'type' }] },
        });
        expect(r.added).toHaveLength(0);
      });
    });
  },
);
