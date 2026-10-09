import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CheckClaimText } from '../src/modules/catalog/application/claim-text/check-claim-text.service';
import { ALLOWED_PRODUCT_TYPES_READER } from '../src/modules/catalog/application/ports/allowed-product-types.reader';
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
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({
            add: (_m: unknown, offer: Offer) => {
              stored.push(offer);
              return Promise.resolve(null);
            },
            findById: () => Promise.resolve(null),
          })
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(eligible) })
          .overrideProvider(ALLOWED_PRODUCT_TYPES_READER)
          .useValue({ allowedFor: () => Promise.resolve('all') })
          .overrideProvider(CheckClaimText)
          .useValue({ execute: () => Promise.resolve({ ok: true, value: [] }) })
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

  it('maps every refusal code of the use case to a status', () => {
    const codes = [
      'access.denied',
      'access.unavailable',
      'request.throttled',
      'seller.not-eligible',
      'type.not-allowed',
      'setting.sell-from-catalogue-off',
      'product.not-found',
      'offer.exists-for-product',
      'offer.sku-taken',
      'claim-text.refused',
      'validation.failed',
    ];
    for (const code of codes) {
      expect(OWN_OFFER_STATUS[code] ?? (code === 'access.denied' ? 403 : undefined)).toBeDefined();
    }
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
  });
});
