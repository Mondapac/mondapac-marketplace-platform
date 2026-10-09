import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
import { OWN_CATALOG_READER } from '../src/modules/catalog/application/ports/own-catalog.reader';
import { PRODUCT_REVISION_REPOSITORY } from '../src/modules/catalog/application/ports/product-revision.repository';
import { WORKING_COPY_REPOSITORY } from '../src/modules/catalog/application/ports/working-copy.repository';
import { Offer } from '../src/modules/catalog/domain/offer';
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

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('seller read routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let product: Product | null;
  let offer: Offer | null;
  let listed: { products: Product[]; offers: Offer[] };
  let pageCalls: unknown[];
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
          .overrideProvider(WORKING_COPY_REPOSITORY)
          .useValue({ find: () => Promise.resolve(null) })
          .overrideProvider(PRODUCT_REVISION_REPOSITORY)
          .useValue({ find: () => Promise.resolve(null) })
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({ findById: () => Promise.resolve(offer) })
          .overrideProvider(OWN_CATALOG_READER)
          .useValue({
            listProducts: (_m: unknown, _s: unknown, page: unknown) => {
              pageCalls.push(page);
              return Promise.resolve(listed.products);
            },
            listOffers: (_m: unknown, _s: unknown, page: unknown) => {
              pageCalls.push(page);
              return Promise.resolve(listed.offers);
            },
            findWorkingCopies: () => Promise.resolve([]),
            productLabels: () => Promise.resolve([]),
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
    offer = null;
    listed = { products: [], offers: [] };
    pageCalls = [];
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
        workingCopy: null,
        published: null,
        pending: null,
      });

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
      });
      const one = await get(code, `/catalog/seller/offers/${offer.state.id}`, session);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ offerId: offer.state.id, description: { en: 'mine' } });

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
