import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  ALLOWED_PRODUCT_TYPES_READER,
  type AllowedProductTypes,
} from '../src/modules/catalog/application/ports/allowed-product-types.reader';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
import { OWN_CATALOG_READER } from '../src/modules/catalog/application/ports/own-catalog.reader';
import { PRODUCT_REVISION_REPOSITORY } from '../src/modules/catalog/application/ports/product-revision.repository';
import { WORKING_COPY_REPOSITORY } from '../src/modules/catalog/application/ports/working-copy.repository';
import { Offer } from '../src/modules/catalog/domain/offer';
import { ATTRIBUTE_VALUE_SUGGESTION_STORE } from '../src/modules/catalog/application/ports/attribute-value-suggestion.store';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import { Product, type ProductState } from '../src/modules/catalog/domain/product';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller read routes over HTTP (catalog design 8.2, 9.2a): the real guards,
// controller, gate and the real `own-offer.create-on-platform-product` use case, with identity's
// ports and catalog's stores as in-memory fakes. Proved here: the seller session, the CSRF token,
// the key, the closed body, the status of each refusal, the throttle headers and the log line.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const PRODUCT = id<'Product'>(0xc001);
const VARIANT = id<'Variant'>(0xc101);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('seller read routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let product: Product | null;
  let changeRequest: unknown;
  let offer: Offer | null;
  let listed: { products: Product[]; offers: Offer[] };
  let pageCalls: unknown[];
  let listCalls: { sellerId: unknown; filter: unknown; order: unknown; page: unknown }[];
  let countCalls: { sellerId: unknown; filters: unknown }[];
  let allowed: AllowedProductTypes | null;
  let allowedAsked: unknown[];
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({ findById: () => Promise.resolve(product) })
          .overrideProvider(ATTRIBUTE_VALUE_SUGGESTION_STORE)
          .useValue({ listOfProduct: () => Promise.resolve([]) })
          .overrideProvider(WORKING_COPY_REPOSITORY)
          .useValue({ find: () => Promise.resolve(null) })
          .overrideProvider(PRODUCT_REVISION_REPOSITORY)
          .useValue({
            find: () => Promise.resolve(null),
            latestChangeRequest: () => Promise.resolve(changeRequest),
          })
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({ findById: () => Promise.resolve(offer) })
          .overrideProvider(ALLOWED_PRODUCT_TYPES_READER)
          .useValue({
            allowedFor: (_context: unknown, sellerId: unknown) => {
              allowedAsked.push(sellerId);
              return Promise.resolve(allowed);
            },
          })
          .overrideProvider(OWN_CATALOG_READER)
          .useValue({
            listProducts: (_m: unknown, _s: unknown, page: unknown) => {
              pageCalls.push(page);
              return Promise.resolve(listed.products);
            },
            countProductViews: (_m: unknown, sellerId: unknown, filters: unknown) => {
              countCalls.push({ sellerId, filters });
              return Promise.resolve({
                byStatus: { draft: 3, published: 1, matched: 1, retired: 1 },
                inReview: 1,
              });
            },
            listProductPage: (
              _m: unknown,
              sellerId: unknown,
              filter: unknown,
              order: unknown,
              page: unknown,
            ) => {
              listCalls.push({ sellerId, filter, order, page });
              return Promise.resolve({ kind: 'rows', rows: [] });
            },
            listOffers: (_m: unknown, _s: unknown, page: unknown) => {
              pageCalls.push(page);
              return Promise.resolve(listed.offers);
            },
            findWorkingCopies: () => Promise.resolve([]),
            productLabels: () => Promise.resolve([]),
            sellUnitsOf: () =>
              Promise.resolve([{ variantId: VARIANT, variantSku: 'SKU-1-A', selling: false }]),
            offerStatusCounts: () =>
              Promise.resolve({ draft: 0, pendingFirstPublish: 0, changesNeeded: 0, published: 0 }),
            pendingReviewCount: () => Promise.resolve(0),
            productForm: () => Promise.resolve({ fields: [], categories: [] }),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const state = (code: string): ProductState => ({
    id: PRODUCT,
    marketId: code as AccountState['marketId'],
    scope: 'SELLER',
    ownerSellerId: SELLER,
    createdBySellerId: SELLER,
    typeCode: 'simple',
    variantModel: 'single',
    familyCode: 'default',
    productCode: 'P00000001',
    status: 'draft',
    discardedAt: null,
    withdrawnAt: null,
    retiredAt: null,
    pausedAt: null,
    pausedByAccountId: null,
    ownBrand: false,
    lastChangedAt: START,
    version: 3,
    createdAt: START,
    publishedRevisionId: null,
    pendingRevisionId: null,
    pendingSubmittedAt: null,
    variants: [],
  });

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'offer-0001'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
    )!.id;
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 3,
      createdAt: START,
    });
    fakes.seedAccount({
      id: OWNER,
      marketId,
      population: 'seller',
      email: { typed: 'Owner@Example.com', normalized: 'owner@example.com' },
      displayName: 'Owner',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe001),
      marketId,
      accountId: OWNER,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf001),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
    product = Product.restore(state(code));
  }

  function sessionOf(code: string) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf101),
        marketId: code as AccountState['marketId'],
        accountId: OWNER,
        population: 'seller',
        sellerId: SELLER,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const get = (code: string, path: string, extra: Record<string, string>) =>
    http()
      .get(path)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...extra });

  const offerOf = (code: string, sellerId = SELLER): Offer => {
    const created = Offer.create({
      id: id<'Offer'>(0xa501),
      marketId: code as AccountState['marketId'],
      sellerId,
      productId: PRODUCT,
      sellerSku: 'SKU-1',
      conditionCode: 'new',
      description: { en: 'mine' },
      now: START,
    });
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    product = null;
    changeRequest = null;
    offer = null;
    listed = { products: [], offers: [] };
    pageCalls = [];
    listCalls = [];
    countCalls = [];
    allowed = 'all';
    allowedAsked = [];
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the four read routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    for (const [path, statuses] of [
      ['/catalog/seller/products', ['200', '400', '403', '503']],
      ['/catalog/seller/products/{productId}', ['200', '403', '404', '503']],
      ['/catalog/seller/offers', ['200', '400', '403', '503']],
      ['/catalog/seller/offers/{offerId}', ['200', '403', '404', '503']],
    ] as const) {
      for (const status of statuses) {
        expect(document.paths[path]?.get?.responses).toHaveProperty(status);
      }
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the seller’s products with no-store and passes a parsed page to the store', async () => {
      await boot();
      await seeded(code);
      listed = { products: [product!], offers: [] };

      const answer = await get(
        code,
        `/catalog/seller/products?limit=5&afterId=${id<'Product'>(0xc999)}`,
        sessionOf(code),
      );

      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.body).toMatchObject({
        items: [{ productId: PRODUCT, status: 'draft', draftName: null }],
        nextAfterId: null,
      });
      expect(pageCalls).toEqual([{ afterId: id<'Product'>(0xc999), limit: 6 }]);
      expect(
        logLines.find((l) => l.msg === 'catalog.own-products-list' && l.outcome),
      ).toMatchObject({ outcome: 'ok', marketId: code });
    });

    it('refuses a bad limit, a bad afterId and an unknown query key without touching the store', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      for (const [query, path] of [
        ['limit=0', 'limit'],
        ['limit=abc', 'limit'],
        ['limit=51', 'limit'],
        ['afterId=nope', 'afterId'],
        ['sellerId=x', 'sellerId'],
      ] as const) {
        const answer = await get(code, `/catalog/seller/products?${query}`, session);
        expect(answer.status).toBe(400);
        expect(answer.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
      expect(pageCalls).toHaveLength(0);
    });

    it('lists in list mode with views, counts and a parsed query, scoped to the calling seller', async () => {
      await boot();
      await seeded(code);

      const answer = await get(
        code,
        '/catalog/seller/products?view=live&q=dates&paused=false&sort=name&page=2&pageSize=50&typeCode=simple',
        sessionOf(code),
      );

      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.body).toEqual({
        items: [],
        total: 2,
        page: 2,
        pageSize: 50,
        counts: { all: 6, drafts: 3, live: 2, inactive: 1, inReview: 1 },
      });
      expect(countCalls).toHaveLength(1);
      expect(countCalls[0]!.sellerId).toBe(SELLER);
      expect(pageCalls).toHaveLength(0);
      expect(
        logLines.find((l) => l.msg === 'catalog.own-products-list' && l.outcome),
      ).toMatchObject({ outcome: 'ok', marketId: code });
    });

    it('reads the list from the first page when only page is given, and reads past the end as empty', async () => {
      await boot();
      await seeded(code);

      const first = await get(code, '/catalog/seller/products?page=1', sessionOf(code));
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ page: 1, pageSize: 25, total: 6 });
      expect(listCalls[0]).toMatchObject({
        sellerId: SELLER,
        order: { sort: 'updated', direction: 'desc' },
        page: { offset: 0, limit: 25 },
        filter: { inReview: false, paused: null, text: null },
      });
      const past = await get(code, '/catalog/seller/products?page=3', sessionOf(code));
      expect(past.status).toBe(200);
      expect(listCalls).toHaveLength(1);
    });

    it('refuses a bad list query with validation.failed and without touching the store', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      for (const [query, path] of [
        ['view=active', 'view'],
        ['page=0', 'page'],
        ['page=abc', 'page'],
        ['page=201&pageSize=50', 'page'],
        ['page=1&pageSize=30', 'pageSize'],
        ['page=1&paused=yes', 'paused'],
        ['page=1&status=withdrawn', 'status'],
        ['page=1&sort=price', 'sort'],
        ['page=1&categoryId=nope', 'categoryId'],
        ['page=1&q=' + 'x'.repeat(101), 'q'],
        ['page=1&q=a%00b', 'q'],
        ['page=1&limit=5', 'limit'],
        ['page=1&afterId=' + id<'Product'>(0xc999), 'afterId'],
        ['page=1&sellerId=x', 'sellerId'],
      ] as const) {
        const answer = await get(code, `/catalog/seller/products?${query}`, session);
        expect(answer.status).toBe(400);
        expect(answer.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
      expect(countCalls).toHaveLength(0);
      expect(listCalls).toHaveLength(0);
    });

    it('serves the product form options from the Market configuration, before any product id', async () => {
      await boot();
      await seeded(code);

      const answer = await get(code, '/catalog/seller/products/options', sessionOf(code));

      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      const body = answer.body as {
        productTypes: string[];
        conditions: string[];
        locales: { default: string; supported: string[] };
        sellerCanCreateProduct: boolean;
        productStatuses: string[];
        offerStatuses: string[];
      };
      expect(body.productTypes.length).toBeGreaterThan(0);
      expect(body.conditions.length).toBeGreaterThan(0);
      expect(body.locales.supported).toContain(body.locales.default);
      expect(typeof body.sellerCanCreateProduct).toBe('boolean');
      expect(body.productStatuses).toEqual(
        expect.arrayContaining(['draft', 'unpublished', 'published']),
      );
      expect(body.productStatuses).not.toContain('discarded');
      expect(body.productStatuses).not.toContain('withdrawn');
      expect(body.offerStatuses).toContain('draft');
      expect(body.offerStatuses).not.toContain('deleted');
      expect(
        logLines.find((l) => l.msg === 'catalog.own-product-options' && l.outcome),
      ).toMatchObject({ outcome: 'ok', marketId: code });
      expect((await get(code, '/catalog/seller/products/options', {})).status).toBe(401);
    });

    it('narrows the product types to what the seller may sell (SEL-12), and offers none on a fault', async () => {
      await boot();
      await seeded(code);
      const all = (await get(code, '/catalog/seller/products/options', sessionOf(code))).body as {
        productTypes: string[];
      };
      expect(allowedAsked).toEqual([SELLER]);
      const [first] = all.productTypes;
      if (first === undefined) throw new Error('the Market offers no product type');

      allowed = new Set([first, 'not-a-market-type']);
      const narrowed = await get(code, '/catalog/seller/products/options', sessionOf(code));
      expect(narrowed.status).toBe(200);
      expect((narrowed.body as { productTypes: string[] }).productTypes).toEqual([first]);

      allowed = new Set();
      const none = await get(code, '/catalog/seller/products/options', sessionOf(code));
      expect((none.body as { productTypes: string[] }).productTypes).toEqual([]);

      allowed = null;
      const fault = await get(code, '/catalog/seller/products/options', sessionOf(code));
      expect(fault.status).toBe(200);
      expect((fault.body as { productTypes: string[] }).productTypes).toEqual([]);
    });

    it('needs a session', async () => {
      await boot();
      await seeded(code);
      expect((await get(code, '/catalog/seller/products', {})).status).toBe(401);
      expect((await get(code, '/catalog/seller/offers', {})).status).toBe(401);
    });

    it('reads an own product and answers another seller’s, a malformed id and a missing one alike', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const own = await get(code, `/catalog/seller/products/${PRODUCT}`, session);
      expect(own.status).toBe(200);
      expect(own.headers['cache-control']).toBe('no-store');
      expect(own.body).toMatchObject({
        productId: PRODUCT,
        maxVariants: expect.any(Number) as number,
        form: { fields: [], categories: [], taxCategoryCodes: expect.any(Array) as string[] },
        workingCopy: null,
        published: null,
        pending: null,
        changeRequest: null,
        pausedAt: null,
      });

      // An admin pause shows as the instant it happened (the seller's banner "Mondapac paused this product").
      product = Product.restore({
        ...state(code),
        status: 'published',
        pausedAt: START,
        pausedByAccountId: id<'Account'>(0xa001),
      });
      const paused = await get(code, `/catalog/seller/products/${PRODUCT}`, session);
      expect(paused.status).toBe(200);
      expect(paused.body).toMatchObject({ status: 'published', pausedAt: START.toString() });
      product = Product.restore(state(code));

      changeRequest = {
        revisionId: id<'ProductRevision'>(0xd001),
        revisionNo: 2,
        reasonCode: 'description-claim',
        decidedAt: START,
      };
      const sentBack = await get(code, `/catalog/seller/products/${PRODUCT}`, session);
      expect(sentBack.body).toMatchObject({
        changeRequest: {
          revisionId: id<'ProductRevision'>(0xd001),
          revisionNo: 2,
          reasonCode: 'description-claim',
          decidedAt: START.toString(),
        },
      });
      changeRequest = null;

      product = Product.restore({ ...state(code), ownerSellerId: id<'Seller'>(0xb999) });
      const other = await get(code, `/catalog/seller/products/${PRODUCT}`, session);
      product = null;
      const missing = await get(code, `/catalog/seller/products/${PRODUCT}`, session);
      const malformed = await get(code, '/catalog/seller/products/not-an-id', session);
      for (const answer of [other, missing, malformed]) {
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({ statusCode: 404, code: 'product.not-found' });
      }
    });

    it('lists and reads Offers, hiding another seller’s and a malformed id', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      offer = offerOf(code);
      listed = { products: [], offers: [offer] };

      const list = await get(code, '/catalog/seller/offers', session);
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({
        items: [{ offerId: offer.state.id, sellerSku: 'SKU-1', status: 'draft', listed: false }],
        nextAfterId: null,
        counts: { draft: 0, pendingFirstPublish: 0, changesNeeded: 0, published: 0 },
      });
      const one = await get(code, `/catalog/seller/offers/${offer.state.id}`, session);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        offerId: offer.state.id,
        description: { en: 'mine' },
        sellUnits: [{ variantId: VARIANT, variantSku: 'SKU-1-A', selling: false }],
      });

      offer = offerOf(code, id<'Seller'>(0xb999));
      const other = await get(code, `/catalog/seller/offers/${offer.state.id}`, session);
      const malformed = await get(code, '/catalog/seller/offers/not-an-id', session);
      for (const answer of [other, malformed]) {
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({ statusCode: 404, code: 'offer.not-found' });
      }
    });
  });
});
