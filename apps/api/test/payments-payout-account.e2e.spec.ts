import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { AdminListConnectedAccounts } from '../src/modules/payments/application/use-cases/admin-list-connected-accounts.use-case';
import { AdminViewConnectedAccount } from '../src/modules/payments/application/use-cases/admin-view-connected-account.use-case';
import { ConnectPayoutAccount } from '../src/modules/payments/application/use-cases/connect-payout-account.use-case';
import { OpenPayoutAccountLink } from '../src/modules/payments/application/use-cases/open-payout-account-link.use-case';
import { ViewPayoutAccount } from '../src/modules/payments/application/use-cases/view-payout-account.use-case';
import { PAYOUT_ACCOUNT_STATUS } from '../src/modules/payments/presentation/seller-payout-account.controller';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller payout-account routes and the admin connected-account routes over HTTP: the real
// guards and controllers; the use cases are stubs, so this proves the session, the panel
// population, CSRF and Origin, the closed `{ code }` body, the status of each refusal, the answer
// shape and `no-store`. The use cases have their own specs.

const START = Temporal.Instant.from('2026-10-15T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const ADMIN = id<'Account'>(0xa001);
const SELLER = id<'Seller'>(0xb020);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const UNTIL = START.add({ hours: 24 });

const view = (patch: object = {}) => ({
  status: 'enabled',
  ready: false,
  requirementsDue: 0,
  requirementsPastDue: false,
  secondFactorActive: true,
  coolingOffUntil: UNTIL,
  payoutsPaused: true,
  changes: [{ detectedAt: START, kind: 'updated' as const }],
  ...patch,
});
const row = (patch: object = {}) => ({
  sellerId: SELLER,
  sellerName: null,
  status: 'enabled',
  ready: false,
  requirementsDue: 0,
  requirementsPastDue: false,
  coolingOffUntil: UNTIL,
  payoutsPaused: true,
  lastReadAt: START,
  createdAt: START,
  ...patch,
});

it('maps every refusal code of the payout-account routes to its exact status', () => {
  expect(PAYOUT_ACCOUNT_STATUS).toMatchObject({
    'payments.payout-account.not-found': 404,
    'payments.payout-account.rejected': 409,
    'payments.payout-account.second-factor-required': 403,
    'payments.unavailable': 503,
    'second-factor.invalid': 400,
    'second-factor.locked': 429,
  });
});

describe.each(TEST_MARKETS)('payout account over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const stub = (name: string) => ({
    execute: (_c: unknown, input: unknown) => {
      calls.push({ name, input });
      return Promise.resolve(next);
    },
  });

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(ViewPayoutAccount)
          .useValue(stub('view'))
          .overrideProvider(ConnectPayoutAccount)
          .useValue(stub('connect'))
          .overrideProvider(OpenPayoutAccountLink)
          .useValue(stub('link'))
          .overrideProvider(AdminListConnectedAccounts)
          .useValue(stub('admin-list'))
          .overrideProvider(AdminViewConnectedAccount)
          .useValue(stub('admin-view')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'pay-seed-0001'), {});
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
    for (const [accountId, population, label] of [
      [OWNER, 'seller', 'owner'],
      [ADMIN, 'admin', 'admin'],
    ] as const) {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: label,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    }
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
  }

  function sessionOf(population: 'seller' | 'admin', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId: population === 'seller' ? OWNER : ADMIN,
        population,
        sellerId: population === 'seller' ? SELLER : null,
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
  const seller = () => sessionOf('seller', 1);
  const admin = () => sessionOf('admin', 2);

  const call = (
    method: 'get' | 'post',
    population: 'seller' | 'admin',
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };
  const ACCOUNT = '/payments/seller/payout-account';
  const ADMIN_LIST = '/payments/admin/connected-accounts';

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(view());
  });
  afterEach(async () => {
    await app?.close();
  });

  describe('seller', () => {
    it('answers the state with the waiting period, the pause, the factor flag and the changes', async () => {
      await boot();
      const res = await call('get', 'seller', ACCOUNT, seller());

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        status: 'enabled',
        ready: false,
        requirementsDue: 0,
        requirementsPastDue: false,
        secondFactorActive: true,
        coolingOffUntil: UNTIL.toString(),
        payoutsPaused: true,
        changes: [{ detectedAt: START.toString(), kind: 'updated' }],
      });
      next = ok(view({ coolingOffUntil: null, payoutsPaused: false, changes: [] }));
      expect((await call('get', 'seller', ACCOUNT, seller())).body).toMatchObject({
        coolingOffUntil: null,
        changes: [],
      });
    });

    it('passes the code of the closed JSON body to connect and link, and adds the page url', async () => {
      await boot();
      const session = seller();
      next = ok({ ...view(), url: 'https://connect.stripe.test/setup/s/abc' });

      const connect = await call('post', 'seller', ACCOUNT, session, { code: '123456' });
      expect(connect.status).toBe(200);
      expect(connect.headers['cache-control']).toBe('no-store');
      expect(connect.body).toMatchObject({
        url: 'https://connect.stripe.test/setup/s/abc',
        secondFactorActive: true,
        payoutsPaused: true,
      });
      const link = await call('post', 'seller', `${ACCOUNT}/link`, session, { code: 'abcd-efgh' });
      expect(link.status).toBe(200);
      expect(calls).toEqual([
        { name: 'connect', input: { code: '123456' } },
        { name: 'link', input: { code: 'abcd-efgh' } },
      ]);
    });

    it('refuses a write without CSRF or a same-origin panel, with a stray field and not as JSON', async () => {
      await boot();
      const session = seller();
      const body = { code: '123456' };

      expect((await call('post', 'seller', ACCOUNT, { cookie: session.cookie }, body)).status).toBe(
        403,
      );
      const noOrigin = await http()
        .post(ACCOUNT)
        .set({ 'x-market-id': code, ...session })
        .send(body);
      expect(noOrigin.status).toBe(403);
      const crossSite = await http()
        .post(ACCOUNT)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...session })
        .set('sec-fetch-site', 'cross-site')
        .send(body);
      expect(crossSite.status).toBe(403);
      const extra = await call('post', 'seller', ACCOUNT, session, { code: '1', url: 'x' });
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({ code: 'validation.failed' });
      const text = await http()
        .post(ACCOUNT)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...session })
        .set('content-type', 'text/plain')
        .send('x');
      expect(text.status).toBe(415);
      expect(calls).toEqual([]);
    });

    it('maps the two-step refusals: required, invalid, locked with its wait, and the rest', async () => {
      await boot();
      const session = seller();
      const post = (path = ACCOUNT) => call('post', 'seller', path, session, { code: '000000' });

      next = err({ code: 'payments.payout-account.second-factor-required' });
      const required = await post();
      expect(required.status).toBe(403);
      expect(required.body).toEqual({
        statusCode: 403,
        code: 'payments.payout-account.second-factor-required',
      });
      next = err({ code: 'second-factor.invalid' });
      const invalid = await post(`${ACCOUNT}/link`);
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({ statusCode: 400, code: 'second-factor.invalid' });
      next = err({ code: 'second-factor.locked', retryAfterSeconds: 900 });
      const locked = await post();
      expect(locked.status).toBe(429);
      expect(locked.headers['retry-after']).toBe('900');
      expect(locked.body).toEqual({
        statusCode: 429,
        code: 'second-factor.locked',
        details: { retryAfterSeconds: 900 },
      });
      next = err({ code: 'payments.payout-account.not-found' });
      expect((await post(`${ACCOUNT}/link`)).status).toBe(404);
      next = err({ code: 'payments.payout-account.rejected' });
      expect((await post()).status).toBe(409);
      next = err({ code: 'payments.unavailable' });
      expect((await post()).status).toBe(503);
      next = err({ code: 'access.denied' });
      expect((await post()).status).toBe(403);
    });
  });

  describe('admin', () => {
    it('lists the accounts with a cursor and a status filter, answering the contract row only', async () => {
      await boot();
      next = ok({ items: [row()], nextCursor: '1.cursor' });

      const res = await call('get', 'admin', `${ADMIN_LIST}?status=enabled&cursor=abc`, admin());

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        items: [
          {
            sellerId: SELLER,
            sellerName: null,
            status: 'enabled',
            ready: false,
            requirementsDue: 0,
            requirementsPastDue: false,
            coolingOffUntil: UNTIL.toString(),
            payoutsPaused: true,
            lastReadAt: START.toString(),
            createdAt: START.toString(),
          },
        ],
        nextCursor: '1.cursor',
      });
      expect(calls).toEqual([{ name: 'admin-list', input: { status: 'enabled', cursor: 'abc' } }]);
    });

    it('views one account with its changes and maps invalid, not found and denied', async () => {
      await boot();
      const session = admin();
      const one = `${ADMIN_LIST}/${SELLER}`;
      next = ok({ ...row(), changes: [{ detectedAt: START, kind: 'initial' }] });

      const res = await call('get', 'admin', one, session);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        sellerId: SELLER,
        changes: [{ detectedAt: START.toString(), kind: 'initial' }],
      });
      expect(calls).toEqual([{ name: 'admin-view', input: { sellerId: SELLER } }]);

      next = err({ code: 'payments.connected-account.not-found' });
      const missing = await call('get', 'admin', one, session);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({
        statusCode: 404,
        code: 'payments.connected-account.not-found',
      });
      next = err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
      const invalid = await call('get', 'admin', `${ADMIN_LIST}/nope`, session);
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ details: { fields: [{ path: 'sellerId' }] } });
      next = err({ code: 'access.denied' });
      expect((await call('get', 'admin', ADMIN_LIST, session)).status).toBe(403);
    });
  });
});
