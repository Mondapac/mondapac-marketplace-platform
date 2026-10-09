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
      } = {},
    ) {
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
        { unitOfWork, products, submit, eligibility, allowedTypes },
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
      const create = new OwnProductCreate(gate, {
        unitOfWork,
        products: createProducts,
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
      return { useCase, create, added, stored, copies, revisions, matched, events, seed };
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

    describe('own-product.create', () => {
      it('creates a draft SELLER product owned by the actor’s seller', async () => {
        const r = rig();
        const created = await r.create.execute(contextOf('seller'), { typeCode: 'simple' });
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
      });

      it('refuses in order: not eligible, setting off, unknown type, SEL-12, spent budget', async () => {
        const call = (options: Parameters<typeof rig>[1], typeCode = 'simple') => {
          const r = rig(undefined, options);
          return r.create
            .execute(contextOf('seller'), { typeCode })
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
          expect(await r.create.execute(contextOf(population), { typeCode: 'simple' })).toEqual({
            ok: false,
            error: { code: 'access.denied' },
          });
        }
        expect(await r.create.execute(contextOf('seller'), {} as { typeCode: string })).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'typeCode', code: 'type' }] },
        });
        expect(r.added).toHaveLength(0);
      });
    });
  },
);
