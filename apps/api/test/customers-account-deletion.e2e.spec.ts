import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ACCOUNT_DELETION_SETTINGS_REPOSITORY } from '../src/modules/customers/application/ports/account-deletion-settings.repository';
import { MemoryAccountDeletionSettings } from '../src/modules/customers/application/testing/in-memory-account-deletion';
import { SetAccountDeletionSettings } from '../src/modules/customers/application/use-cases/set-account-deletion-settings.use-case';
import { ViewAccountDeletionSettings } from '../src/modules/customers/application/use-cases/view-account-deletion-settings.use-case';
import { DEFAULT_ACCOUNT_DELETION_SETTINGS } from '../src/modules/customers/domain/account-deletion-settings';
import { CUSTOMERS_STATUS } from '../src/modules/customers/presentation/http-answers';
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

// The account deletion routes over HTTP: the real guards and controllers. The admin routes use
// stub use cases, so this proves the session, the admin population, Origin and CSRF, the closed
// body (top level and settings), the status of each refusal, the answer shape and `no-store`.
// The customer route runs the real use case on an in-memory store: it takes only a customer
// session and answers the two fields. The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-26T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const SELLER_ACCOUNT = id<'Account'>(0xa101);
const CUSTOMER = id<'Account'>(0xa201);
const SELLER = id<'Seller'>(0xb020);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const ADMIN_PATH = '/customers/admin/account-deletion-settings';
const ME_PATH = '/customers/me/account-deletion';
const VIEW = { version: 2, settings: { enabled: true, waitingPeriodDays: 14 } };
const REASON = 'Legal review finished';

it('maps every refusal code of the customers routes to its exact status', () => {
  expect(CUSTOMERS_STATUS).toEqual({
    'validation.failed': 400,
    'customers.address-not-found': 404,
    'customers.address-limit-reached': 422,
    'customers.conflict': 409,
    'customers.account-deletion-disabled': 403,
    'customers.unavailable': 503,
  });
});

describe.each(TEST_MARKETS)('account deletion routes over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  let actorKinds: string[];
  let store: MemoryAccountDeletionSettings;
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const stub = (name: string) => ({
    execute: (context: { actor: { kind: string } }, input: unknown) => {
      calls.push({ name, input });
      actorKinds.push(context.actor.kind);
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
          .overrideProvider(ACCOUNT_DELETION_SETTINGS_REPOSITORY)
          .useValue(store)
          .overrideProvider(ViewAccountDeletionSettings)
          .useValue(stub('view'))
          .overrideProvider(SetAccountDeletionSettings)
          .useValue(stub('set')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'deletion-seed-01'), {});
    for (const [accountId, population, label] of [
      [ADMIN, 'admin', 'admin'],
      [SELLER_ACCOUNT, 'seller', 'seller'],
      [CUSTOMER, 'customer', 'customer'],
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
  }

  function sessionOf(population: 'seller' | 'admin' | 'customer', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId:
          population === 'seller' ? SELLER_ACCOUNT : population === 'admin' ? ADMIN : CUSTOMER,
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

  const call = (
    method: 'get' | 'put',
    population: 'seller' | 'admin',
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](ADMIN_PATH)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };
  const body = (extra: Record<string, unknown> = {}) => ({
    expectedVersion: 2,
    settings: { enabled: true, waitingPeriodDays: 14 },
    reason: REASON,
    ...extra,
  });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    store = new MemoryAccountDeletionSettings();
    calls = [];
    actorKinds = [];
    next = ok(VIEW);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read and replace the setting, passing the reason to the use case', async () => {
    await boot();
    const session = sessionOf('admin', 2);

    const read = await call('get', 'admin', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual(VIEW);

    const set = await call('put', 'admin', session, body());
    expect(set.status).toBe(200);
    expect(set.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual([
      { name: 'view', input: {} },
      {
        name: 'set',
        input: {
          settings: { enabled: true, waitingPeriodDays: 14 },
          expectedVersion: 2,
          reason: REASON,
        },
      },
    ]);
  });

  it('reads only the admin session: without one, or with a seller cookie, the gate sees an anonymous actor', async () => {
    await boot();
    await call('get', 'admin', {});
    await http()
      .get(ADMIN_PATH)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...sessionOf('seller', 4) });
    await call('get', 'admin', sessionOf('admin', 5));
    // The real gate refuses the anonymous actor (access.unauthenticated); the stub only records it.
    expect(actorKinds).toEqual(['anonymous', 'anonymous', 'authenticated']);
  });

  it('refuses a change from a foreign Origin or a cross-site fetch', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const foreign = await http()
      .put(ADMIN_PATH)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...session,
        origin: 'https://evil.example',
      })
      .send(body());
    expect(foreign.status).toBe(403);
    const crossSite = await http()
      .put(ADMIN_PATH)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...session,
        'sec-fetch-site': 'cross-site',
      })
      .send(body());
    expect(crossSite.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses a change without CSRF, with a stray field at either level and not as JSON', async () => {
    await boot();
    const session = sessionOf('admin', 2);

    expect((await call('put', 'admin', { cookie: session.cookie }, body())).status).toBe(403);
    const extra = await call('put', 'admin', session, body({ x: 1 }));
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'x', code: 'unknown-field' }] },
    });
    const nested = await call(
      'put',
      'admin',
      session,
      body({ settings: { enabled: true, waitingPeriodDays: 14, days: 3 } }),
    );
    expect(nested.status).toBe(400);
    expect(nested.body).toMatchObject({
      details: { fields: [{ path: 'settings.days', code: 'unknown-field' }] },
    });
    const notObject = await call('put', 'admin', session, body({ settings: [] }));
    expect(notObject.status).toBe(400);
    expect(notObject.body).toMatchObject({
      details: { fields: [{ path: 'settings', code: 'type' }] },
    });
    const text = await http()
      .put(ADMIN_PATH)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('maps invalid, conflict and denied', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const put = () => call('put', 'admin', session, body());

    next = err({ code: 'validation.failed', fields: [{ path: 'reason', code: 'range' }] });
    const invalid = await put();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      details: { fields: [{ path: 'reason', code: 'range' }] },
    });
    next = err({ code: 'customers.conflict' });
    const conflict = await put();
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ statusCode: 409, code: 'customers.conflict' });
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
  });

  describe("the customer's route", () => {
    it('answers the two fields from the session, no-store, off by default', async () => {
      await boot();
      const read = await http()
        .get(ME_PATH)
        .set({ 'x-market-id': code, ...sessionOf('customer', 6) });
      expect(read.status).toBe(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.body).toEqual({
        canDeleteAccount: DEFAULT_ACCOUNT_DELETION_SETTINGS.enabled,
        waitingPeriodDays: DEFAULT_ACCOUNT_DELETION_SETTINGS.waitingPeriodDays,
      });
    });

    it('follows the Market setting', async () => {
      await boot();
      store.rows.push({
        market: code,
        version: 1,
        settings: { enabled: true, waitingPeriodDays: 21 },
        changedAt: START,
        changedBy: ADMIN,
        reason: REASON,
      });
      const read = await http()
        .get(ME_PATH)
        .set({ 'x-market-id': code, ...sessionOf('customer', 7) });
      expect(read.body).toEqual({ canDeleteAccount: true, waitingPeriodDays: 21 });
    });

    it('refuses a visitor, and an admin or seller session', async () => {
      await boot();
      const visitor = await http().get(ME_PATH).set({ 'x-market-id': code });
      expect(visitor.status).toBe(401);
      expect(visitor.body).toMatchObject({ code: 'access.unauthenticated' });
      for (const [population, n] of [
        ['admin', 8],
        ['seller', 9],
      ] as const) {
        const session = sessionOf(population, n);
        const refused = await http()
          .get(ME_PATH)
          .set({ 'x-market-id': code, ...panelHeaders(code, population), ...session });
        expect(refused.status).toBe(401);
      }
    });

    it('has no write route', async () => {
      await boot();
      const session = sessionOf('customer', 10);
      const put = await http()
        .put(ME_PATH)
        .set({ 'x-market-id': code, ...session })
        .send({ canDeleteAccount: true });
      expect(put.status).toBe(404);
    });
  });
});
