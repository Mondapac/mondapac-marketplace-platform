import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { AddSizes } from '../src/modules/catalog/application/products/add-sizes.service';
import { PLATFORM_PRODUCT_STATUS } from '../src/modules/catalog/presentation/platform-product.controller';
import { OWN_PRODUCT_STATUS } from '../src/modules/catalog/presentation/own-product.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// Add sizes over HTTP (catalog design 4.2a, 8.2; variants V9a): the seller route and the platform
// route with their real guards, controller, gate and the real use cases. `AddSizes` itself is a
// FAKE here (scripted answers, no repositories): this file proves routing and mapping only. Its
// guards and effects are in add-sizes.use-cases.spec.ts and the database specs
// (test/db/catalog-product-add-sizes*.db-spec.ts).
// Proved here: the session, the CSRF token, the key, the closed body (offOfferCount only on the
// platform route), the status of each refusal and the answer of the confirm read.

const START = Temporal.Instant.from('2026-11-06T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ROOT = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const OWNER = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const PRODUCT = id<'Product'>(0xc001);
const VARIANT = '01990000-0000-7000-8000-00000000c101';
const BODY = {
  version: 3,
  axes: ['size'],
  optionValues: { size: 'm' },
  replacePending: false,
};
const DONE = {
  productId: PRODUCT,
  variantId: VARIANT,
  version: 4,
  offOfferCount: 0,
  supersededRevisionId: null,
};

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('Add sizes routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let result: unknown;
  let impactResult: unknown;
  let calls: unknown[];
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(true) })
          .overrideProvider(AddSizes)
          .useValue({
            execute: (_c: unknown, input: unknown) => {
              calls.push(input);
              return Promise.resolve(result);
            },
            impact: () => Promise.resolve(impactResult),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'roles-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (scope: string, seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === scope && r.seedCode === seedCode,
      )!.id;
    const account = (accountId: Id<'Account'>, population: 'admin' | 'seller', n: number) =>
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `P${n}@Example.com`, normalized: `p${n}@example.com` },
        displayName: `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    const assign = (n: number, accountId: Id<'Account'>, roleId: Id<'Role'>) =>
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe000 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    account(ROOT, 'admin', 1);
    account(VIEWER, 'admin', 2);
    account(OWNER, 'seller', 3);
    assign(1, ROOT, roleOf('platform', 'platform-administrator'));
    assign(2, VIEWER, roleOf('platform', 'viewer'));
    assign(3, OWNER, roleOf('seller', 'seller-owner'));
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
  }

  function sessionOf(
    code: string,
    population: 'admin' | 'seller',
    account: Id<'Account'>,
    n: number,
  ) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        ...(population === 'seller' ? { sellerId: SELLER } : {}),
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const admin = (code: string, n = 1) => sessionOf(code, 'admin', n === 1 ? ROOT : VIEWER, n);
  const seller = (code: string) => sessionOf(code, 'seller', OWNER, 9);
  const platformPost = (code: string, body: unknown, headers: Record<string, string>) =>
    http()
      .post(`/catalog/admin/platform-products/${PRODUCT}/add-sizes`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers })
      .send(body as object);
  const sellerPost = (code: string, body: unknown, headers: Record<string, string>) =>
    http()
      .post(`/catalog/seller/products/${PRODUCT}/add-sizes`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers })
      .send(body as object);

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    result = ok(DONE);
    impactResult = ok({ productId: PRODUCT, version: 3, offOfferCount: 2 });
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents both routes and the confirm read in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const platform = '/catalog/admin/platform-products/{productId}';
    for (const status of ['200', '400', '403', '404', '409', '429', '503']) {
      expect(document.paths[`${platform}/add-sizes`]?.post?.responses).toHaveProperty(status);
      expect(
        document.paths['/catalog/seller/products/{productId}/add-sizes']?.post?.responses,
      ).toHaveProperty(status);
    }
    expect(document.paths[`${platform}/add-sizes-impact`]?.get?.responses).toHaveProperty('200');
  });

  it('maps the new refusals to a status in both tables', () => {
    // `revision.revert-changes-type` joins with the revert use cases (see `revertTypeRefusal`).
    for (const table of [PLATFORM_PRODUCT_STATUS, OWN_PRODUCT_STATUS]) {
      expect(table).toMatchObject({
        'product.not-simple': 409,
        'confirm.count-changed': 409,
        'product-type.not-allowed': 403,
        'product.family-invalid': 503,
      });
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('adds sizes to a seller product and passes the closed body on', async () => {
      await boot();
      await seeded(code);
      const done = await sellerPost(code, BODY, seller(code));
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ productId: PRODUCT, variantId: VARIANT, version: 4 });
      expect(calls).toEqual([
        expect.objectContaining({ productId: PRODUCT, version: 3, axes: ['size'] }),
      ]);
    });

    it('refuses offOfferCount on the seller route and a missing one on the platform route', async () => {
      await boot();
      await seeded(code);
      const extra = await sellerPost(code, { ...BODY, offOfferCount: 0 }, seller(code));
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'offOfferCount', code: 'unknown-field' }] },
      });
      const missing = await platformPost(code, BODY, admin(code));
      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({ code: 'validation.failed' });
      expect(calls).toEqual([]);
    });

    it('adds sizes to a PLATFORM product for the administrator and answers the Offers taken off sale', async () => {
      await boot();
      await seeded(code);
      result = ok({ ...DONE, offOfferCount: 2 });
      const done = await platformPost(code, { ...BODY, offOfferCount: 2 }, admin(code));
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ offOfferCount: 2, version: 4 });
      expect(calls).toEqual([expect.objectContaining({ productId: PRODUCT, offOfferCount: 2 })]);
    });

    it('answers a moved count with 409 and its current value', async () => {
      await boot();
      await seeded(code);
      result = err({ code: 'confirm.count-changed', currentCount: 3 });
      const moved = await platformPost(code, { ...BODY, offOfferCount: 2 }, admin(code));
      expect(moved.status).toBe(409);
      expect(moved.body).toMatchObject({ code: 'confirm.count-changed' });
    });

    it.each([
      ['product.not-simple', 409],
      ['conflict.stale', 409],
      ['product-type.not-allowed', 403],
      ['product.not-found', 404],
    ])('answers %s with %i on the seller route', async (refusal, status) => {
      await boot();
      await seeded(code);
      result = err({ code: refusal });
      const refused = await sellerPost(code, BODY, seller(code));
      expect(refused.status).toBe(status);
      expect(refused.body).toMatchObject({ code: refusal });
    });

    it('refuses without the CSRF token, without a session and without the key', async () => {
      await boot();
      await seeded(code);
      const root = admin(code);
      const noCsrf = await platformPost(
        code,
        { ...BODY, offOfferCount: 0 },
        { cookie: root.cookie },
      );
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect((await platformPost(code, { ...BODY, offOfferCount: 0 }, {})).status).toBe(401);
      const viewer = await platformPost(code, { ...BODY, offOfferCount: 0 }, admin(code, 2));
      expect(viewer.status).toBe(403);
      expect(viewer.body).toEqual({ statusCode: 403, code: 'access.denied' });
      expect(calls).toEqual([]);
    });

    it('reads the confirm: the count and the version to send back', async () => {
      await boot();
      await seeded(code);
      const read = await http()
        .get(`/catalog/admin/platform-products/${PRODUCT}/add-sizes-impact`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...admin(code) });
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ productId: PRODUCT, version: 3, offOfferCount: 2 });
      expect(read.headers['cache-control']).toBe('no-store');
      const viewer = await http()
        .get(`/catalog/admin/platform-products/${PRODUCT}/add-sizes-impact`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...admin(code, 2) });
      expect(viewer.status).toBe(403);
    });
  });
});
