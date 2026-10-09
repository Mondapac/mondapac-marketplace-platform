import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CheckClaimText } from '../src/modules/catalog/application/claim-text/check-claim-text.service';
import { ALLOWED_PRODUCT_TYPES_READER } from '../src/modules/catalog/application/ports/allowed-product-types.reader';
import {
  CATALOG_MARKET_POLICY,
  type CatalogMarketPolicy,
} from '../src/modules/catalog/application/ports/catalog-market-policy';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { SaveWorkingCopy } from '../src/modules/catalog/application/working-copy/save-working-copy.service';
import type { Offer } from '../src/modules/catalog/domain/offer';
import { Product, type ProductState } from '../src/modules/catalog/domain/product';
import { OWN_OFFER_STATUS } from '../src/modules/catalog/presentation/own-offer.controller';
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

// The seller Offer create route over HTTP (catalog design 4.4, 8.2; slice 7a-3): the real guards,
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

describe('seller Offer create over HTTP (integration, slice 7a-3)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let stored: Offer[];
  let product: Product | null;
  let eligible: boolean;
  let reserve: unknown;
  let addRefusal: string | null;
  let allowed: unknown;
  let verdicts: unknown[];
  let productReads: number;
  let claimChecks: number;
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
          .useValue({
            findById: () => {
              productReads += 1;
              return Promise.resolve(product);
            },
          })
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({
            add: (_m: unknown, offer: Offer) => {
              if (addRefusal !== null) return Promise.resolve(addRefusal);
              stored.push(offer);
              return Promise.resolve(null);
            },
            findById: () => Promise.resolve(null),
          })
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(eligible) })
          .overrideProvider(ALLOWED_PRODUCT_TYPES_READER)
          .useValue({ allowedFor: () => Promise.resolve(allowed) })
          .overrideProvider(CheckClaimText)
          .useValue({
            execute: () => {
              claimChecks += 1;
              return Promise.resolve({ ok: true, value: verdicts });
            },
          })
          .overrideProvider(SaveWorkingCopy)
          .useValue({ reserveSaves: () => Promise.resolve(reserve) }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const state = (code: string): ProductState => ({
    id: PRODUCT,
    marketId: code as AccountState['marketId'],
    scope: 'PLATFORM',
    ownerSellerId: null,
    createdBySellerId: null,
    typeCode: 'simple',
    variantModel: 'single',
    familyCode: 'default',
    productCode: 'P00000001',
    status: 'published',
    discardedAt: null,
    ownBrand: false,
    lastChangedAt: START,
    version: 3,
    createdAt: START,
    publishedRevisionId: id<'ProductRevision'>(0xd001),
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

  const body = (extra: Record<string, unknown> = {}) => ({
    productId: PRODUCT,
    sellerSku: 'SKU-1',
    conditionCode: 'new',
    description: {},
    ...extra,
  });
  const send = (code: string, payload: unknown, headers: Record<string, string>) =>
    http()
      .post('/catalog/seller/offers')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers })
      .send(payload as object);

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    stored = [];
    product = null;
    eligible = true;
    reserve = null;
    addRefusal = null;
    allowed = 'all';
    verdicts = [];
    productReads = 0;
    claimChecks = 0;
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route and its error codes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const responses = document.paths['/catalog/seller/offers']?.post?.responses;
    for (const status of ['201', '400', '403', '404', '409', '422', '429', '503']) {
      expect(responses).toHaveProperty(status);
    }
  });

  it('maps every refusal code of the use case to its exact status', () => {
    expect(OWN_OFFER_STATUS).toEqual({
      'validation.failed': 400,
      'product.not-found': 404,
      'seller.not-eligible': 403,
      'offer.exists-for-product': 409,
      'offer.sku-taken': 409,
      'type.not-allowed': 422,
      'setting.sell-from-catalogue-off': 422,
      'claim-text.refused': 422,
      'request.throttled': 429,
      'access.unavailable': 503,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('creates a draft Offer for the session’s seller and logs the outcome', async () => {
      await boot();
      await seeded(code);

      const created = await send(code, body(), sessionOf(code));

      expect(created.status).toBe(201);
      expect(stored).toHaveLength(1);
      expect(created.body).toEqual({ offerId: stored[0]!.state.id });
      expect(stored[0]!.state).toMatchObject({
        sellerId: SELLER,
        productId: PRODUCT,
        status: 'draft',
        marketId: code,
      });
      expect(logLines.find((l) => l.msg === 'catalog.own-offer-create' && l.outcome)).toMatchObject(
        {
          outcome: 'ok',
          marketId: code,
          correlationId: created.headers['x-correlation-id'] as string,
        },
      );
    });

    it('refuses without the CSRF token and without a session, storing nothing', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const noCsrf = await send(code, body(), { cookie: session.cookie });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect((await send(code, body(), {})).status).toBe(401);
      expect(stored).toHaveLength(0);
    });

    it('refuses an unknown field, a missing field, an array and a non-JSON body', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const extra = await send(code, body({ sellerId: 'x' }), session);
      expect(extra.status).toBe(400);
      expect(extra.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
      });
      const withoutDescription = { productId: PRODUCT, sellerSku: 'SKU-1', conditionCode: 'new' };
      const missing = await send(code, withoutDescription, session);
      expect(missing.body).toMatchObject({
        details: { fields: [{ path: 'description', code: 'required' }] },
      });
      expect((await send(code, [], session)).status).toBe(400);
      const text = await http()
        .post('/catalog/seller/offers')
        .set({
          'x-market-id': code,
          ...panelHeaders(code, 'seller'),
          ...session,
          'content-type': 'text/plain',
        })
        .send('x');
      expect(text.status).toBe(415);
      expect(stored).toHaveLength(0);
    });

    it('answers a spent budget as 429 with Retry-After, before any work', async () => {
      await boot();
      await seeded(code);
      reserve = { code: 'request.throttled', retryAfterSeconds: 12 };

      const throttled = await send(code, body(), sessionOf(code));

      expect(throttled.status).toBe(429);
      expect(throttled.headers['retry-after']).toBe('12');
      expect(throttled.body).toEqual({
        statusCode: 429,
        code: 'request.throttled',
        details: { retryAfterSeconds: 12 },
      });
      expect(stored).toHaveLength(0);
    });

    it('answers a seller who may not sell as 403 and an unknown product as 404', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      eligible = false;
      const notEligible = await send(code, body(), session);
      expect(notEligible.status).toBe(403);
      expect(notEligible.body).toEqual({ statusCode: 403, code: 'seller.not-eligible' });

      eligible = true;
      product = null;
      const unknown = await send(code, body(), session);
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'product.not-found' });
      expect(stored).toHaveLength(0);
    });

    it('answers 409, 422 and 503 with the refusal code', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      for (const refusal of ['offer.exists-for-product', 'offer.sku-taken']) {
        addRefusal = refusal;
        const taken = await send(code, body(), session);
        expect(taken.status).toBe(409);
        expect(taken.body).toEqual({ statusCode: 409, code: refusal });
      }
      addRefusal = null;

      allowed = new Set(['configurable']);
      const notAllowed = await send(code, body(), session);
      expect(notAllowed.status).toBe(422);
      expect(notAllowed.body).toEqual({ statusCode: 422, code: 'type.not-allowed' });

      allowed = null;
      const unavailable = await send(code, body(), session);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body).toEqual({ statusCode: 503, code: 'access.unavailable' });
      expect(stored).toHaveLength(0);
    });

    it('answers a text with a claim as 422 with the refused fields, storing nothing', async () => {
      await boot();
      await seeded(code);
      const locale = app
        .get<CatalogMarketPolicy>(CATALOG_MARKET_POLICY)
        .locales(marketOf(code)).default;
      verdicts = [
        { code: 'claim-text.found', field: 'offer.description', ref: null, locale, hits: [] },
      ];

      const refused = await send(
        code,
        body({ description: { [locale]: 'Certified halal' } }),
        sessionOf(code),
      );

      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        statusCode: 422,
        code: 'claim-text.refused',
        details: { fields: [{ field: 'offer.description', locale }] },
      });
      expect(stored).toHaveLength(0);
    });

    it('refuses the admin panel origin and a missing Sec-Fetch-Site, storing nothing', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const wrongOrigin = await http()
        .post('/catalog/seller/offers')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
        .send(body());
      expect(wrongOrigin.status).toBe(403);
      expect(wrongOrigin.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      const noFetchSite = await http()
        .post('/catalog/seller/offers')
        .set({ 'x-market-id': code, origin: panelHeaders(code, 'seller').origin, ...session })
        .send(body());
      expect(noFetchSite.status).toBe(403);
      expect(noFetchSite.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect(stored).toHaveLength(0);
    });

    it('answers every product that is not offerable with the same 404 body', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const bodies: string[] = [];
      for (const overrides of [
        null,
        { status: 'draft' as const, publishedRevisionId: null },
        { scope: 'SELLER' as const, ownerSellerId: SELLER, createdBySellerId: SELLER },
      ]) {
        product = overrides === null ? null : Product.restore({ ...state(code), ...overrides });
        const answer = await send(code, body(), session);
        expect(answer.status).toBe(404);
        bodies.push(JSON.stringify(answer.body));
      }
      expect(new Set(bodies).size).toBe(1);
    });

    it('does no work before a spent budget answers, and logs no text', async () => {
      await boot();
      await seeded(code);
      reserve = { code: 'request.throttled', retryAfterSeconds: 3 };
      const locale = app
        .get<CatalogMarketPolicy>(CATALOG_MARKET_POLICY)
        .locales(marketOf(code)).default;

      await send(
        code,
        body({ sellerSku: 'SECRET-SKU', description: { [locale]: 'secret text' } }),
        sessionOf(code),
      );

      expect(productReads).toBe(0);
      expect(claimChecks).toBe(0);
      const line = logLines.find((l) => l.msg === 'catalog.own-offer-create' && l.outcome);
      expect(JSON.stringify(line)).not.toMatch(/SECRET-SKU|secret text/);
    });
  });
});
