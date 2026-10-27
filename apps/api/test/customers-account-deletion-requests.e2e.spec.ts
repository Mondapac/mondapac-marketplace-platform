import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ACCOUNT_DELETION_PEERS } from '../src/modules/customers/application/ports/account-deletion-peers';
import type { AccountDeletionPeers } from '../src/modules/customers/application/ports/account-deletion-peers';
import { ACCOUNT_DELETION_REQUEST_REPOSITORY } from '../src/modules/customers/application/ports/account-deletion-request.repository';
import { ACCOUNT_DELETION_SETTINGS_REPOSITORY } from '../src/modules/customers/application/ports/account-deletion-settings.repository';
import {
  MemoryAccountDeletionRequests,
  MemoryAccountDeletionSettings,
} from '../src/modules/customers/application/testing/in-memory-account-deletion';
import { IDENTITY_FACADE, type IdentityFacade } from '../src/modules/identity';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The buyer's deletion request routes over HTTP (customers package 5b): POST, GET current and
// DELETE current on customers/me/deletion-requests, with the real guards, controller and use
// cases. The request and setting stores are in memory; identity is the real facade on the
// identity fakes (so the lock-out of the other sessions is seen); ordering and wallet are fakes.
// Proves the customer comes from the session only (a visitor, an admin or seller cookie and a
// session of another Market are refused), the CSRF token on writes, `no-store` on every answer,
// the closed body, the status of each refusal and the happy path, in both Market fixtures.

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
const PATH = '/customers/me/deletion-requests';
const CURRENT = `${PATH}/current`;
const ADMIN_ID = id<'Account'>(0xad);

describe.each(TEST_MARKETS)('buyer deletion request routes over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let requests: MemoryAccountDeletionRequests;
  let settings: MemoryAccountDeletionSettings;
  let openOrders: number;
  let bound: IdentityFacade | null;
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const zero = { amount: 0n, currency: code === 'AU' ? 'AUD' : 'JPY' };

  const peers = (): AccountDeletionPeers & { bind(peers: unknown): void } => ({
    // The module binds the real facades at start; the test keeps its own.
    bind: () => undefined,
    identity: {
      endOtherCustomerSessions: (context) => bound!.endOtherCustomerSessions(context),
      endAllCustomerSessions: (context, accountId) =>
        bound!.endAllCustomerSessions(context, accountId),
      eraseCustomerAccount: (context, accountId, requestId) =>
        bound!.eraseCustomerAccount(context, accountId, requestId),
    },
    ordering: {
      ownOpenObligations: () => Promise.resolve(ok({ openOrders, pendingRefunds: 0 })),
      openObligationsOf: () => Promise.resolve(ok({ openOrders, pendingRefunds: 0 })),
    },
    wallet: {
      ownBalanceOf: () => Promise.resolve(ok({ available: zero, held: zero })),
      balanceOf: () => Promise.resolve(ok({ available: zero, held: zero })),
    },
    engagement: { forgetAccount: () => Promise.resolve(ok({})) },
    reviews: { detachAuthor: () => Promise.resolve(ok({})) },
  });

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(ACCOUNT_DELETION_REQUEST_REPOSITORY)
          .useValue(requests)
          .overrideProvider(ACCOUNT_DELETION_SETTINGS_REPOSITORY)
          .useValue(settings)
          .overrideProvider(ACCOUNT_DELETION_PEERS)
          .useValue(peers()),
    }));
    bound = app.get<IdentityFacade>(IDENTITY_FACADE);
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

  function sessionOf(population: 'seller' | 'admin' | 'customer', n: number, target = code) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      testMarketContext(target, PLATFORM_TENANT_ID),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: target as AccountState['marketId'],
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
      cookie: `__Host-session-${population}-${target}=${issued.token}`,
      csrf: csrfTokenFor(issued.token),
    };
  }
  const as = (s: { cookie: string; csrf: string }) => ({
    'x-market-id': code,
    cookie: s.cookie,
    'x-csrf-token': s.csrf,
  });
  const turnOn = (days = 14) =>
    settings.rows.push({
      market: code,
      version: settings.rows.length + 1,
      settings: { enabled: true, waitingPeriodDays: days },
      changedAt: START,
      changedBy: ADMIN_ID,
      reason: 'test',
    });
  const live = (n: number) =>
    fakes.sessions.get(id<'Session'>(0xf100 + n))?.session.revokedAt === null;

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    requests = new MemoryAccountDeletionRequests();
    settings = new MemoryAccountDeletionSettings();
    openOrders = 0;
    bound = null;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('refuses a visitor on all three routes', async () => {
    await boot();
    for (const res of [
      await http().post(PATH).set({ 'x-market-id': code }).send({ confirm: true }),
      await http().get(CURRENT).set({ 'x-market-id': code }),
      await http().delete(CURRENT).set({ 'x-market-id': code }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'access.unauthenticated' });
    }
    expect(requests.rows.size).toBe(0);
  });

  it('refuses a write without the CSRF token, and does not read the session past it', async () => {
    await boot();
    turnOn();
    const { cookie } = sessionOf('customer', 1);
    const post = await http()
      .post(PATH)
      .set({ 'x-market-id': code, cookie })
      .send({ confirm: true });
    expect(post.status).toBe(403);
    expect(post.body).toMatchObject({ code: 'request.csrf' });
    expect(post.headers['cache-control']).toBe('no-store');
    const del = await http().delete(CURRENT).set({ 'x-market-id': code, cookie });
    expect(del.status).toBe(403);
    expect(del.body).toMatchObject({ code: 'request.csrf' });
    expect(requests.rows.size).toBe(0);
    // A wrong token is no better.
    const wrong = await http()
      .post(PATH)
      .set({ 'x-market-id': code, cookie, 'x-csrf-token': 'not-the-token' })
      .send({ confirm: true });
    expect(wrong.status).toBe(403);
    expect(requests.rows.size).toBe(0);
  });

  it('refuses an admin or a seller session on every route and writes nothing', async () => {
    await boot();
    turnOn();
    for (const [population, n] of [
      ['admin', 2],
      ['seller', 3],
    ] as const) {
      const session = sessionOf(population, n);
      const headers = { ...as(session), ...panelHeaders(code, population) };
      // The read sees an anonymous caller; a write is stopped by the CSRF check (the token of a
      // panel session is not a customer's) or by the missing session: refused either way.
      const read = await http().get(CURRENT).set(headers);
      expect(read.status).toBe(401);
      expect(read.body).toMatchObject({ code: 'access.unauthenticated' });
      for (const res of [
        await http().post(PATH).set(headers).send({ confirm: true }),
        await http().delete(CURRENT).set(headers),
      ]) {
        expect([401, 403]).toContain(res.status);
        expect(res.headers['cache-control']).toBe('no-store');
      }
      // The panel cookie under the customer cookie's name is no session either.
      const renamed = await http()
        .post(PATH)
        .set({
          'x-market-id': code,
          cookie: `__Host-session-customer-${code}=${session.cookie.split('=')[1]}`,
          'x-csrf-token': session.csrf,
        })
        .send({ confirm: true });
      expect(renamed.status).toBe(401);
    }
    expect(requests.rows.size).toBe(0);
  });

  it('refuses a session of another Market sent to this Market', async () => {
    await boot();
    turnOn();
    const otherCode = TEST_MARKETS.find((m) => m !== code)!;
    const session = sessionOf('customer', 4);
    const token = session.cookie.split('=')[1]!;
    const sameName = {
      'x-market-id': otherCode,
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    };
    const renamed = {
      'x-market-id': otherCode,
      cookie: `__Host-session-customer-${otherCode}=${token}`,
      'x-csrf-token': session.csrf,
    };
    for (const headers of [sameName, renamed]) {
      for (const res of [
        await http().post(PATH).set(headers).send({ confirm: true }),
        await http().get(CURRENT).set(headers),
        await http().delete(CURRENT).set(headers),
      ]) {
        expect(res.status).toBe(401);
      }
    }
    expect(requests.rows.size).toBe(0);
  });

  it('asks, reads, and cancels: 201, 200, 204, then 404, all no-store, other sessions ended', async () => {
    await boot();
    turnOn(14);
    const session = sessionOf('customer', 5);
    sessionOf('customer', 6); // a second session of the same buyer
    expect(live(5) && live(6)).toBe(true);

    const none = await http().get(CURRENT).set(as(session));
    expect(none.status).toBe(404);
    expect(none.body).toMatchObject({ code: 'customers.account-deletion-request-not-found' });
    expect(none.headers['cache-control']).toBe('no-store');

    const made = await http().post(PATH).set(as(session)).send({ confirm: true });
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    expect(made.body).toEqual({
      status: 'pending',
      requestedAt: START.toString(),
      scheduledFor: START.add({ hours: 14 * 24 }).toString(),
      waitingPeriodDays: 14,
    });
    // Only the session that asked is left.
    expect(live(5)).toBe(true);
    expect(live(6)).toBe(false);

    const read = await http().get(CURRENT).set(as(session));
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual(made.body);

    const again = await http().post(PATH).set(as(session)).send({ confirm: true });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'customers.account-deletion-already-requested' });
    expect(again.headers['cache-control']).toBe('no-store');

    const cancelled = await http().delete(CURRENT).set(as(session));
    expect(cancelled.status).toBe(204);
    expect(cancelled.headers['cache-control']).toBe('no-store');
    expect(cancelled.text).toBe('');
    expect((await http().get(CURRENT).set(as(session))).status).toBe(404);
    const nothing = await http().delete(CURRENT).set(as(session));
    expect(nothing.status).toBe(404);
    expect(nothing.headers['cache-control']).toBe('no-store');
    expect([...requests.rows.values()].map((r) => r.status)).toEqual(['cancelled']);
  });

  it('shows a claimed request as executing and answers 409 in progress to a cancel', async () => {
    await boot();
    turnOn(7);
    const session = sessionOf('customer', 7);
    await http().post(PATH).set(as(session)).send({ confirm: true });
    // The job's claim a week later (the buyer's session is still the one that asked).
    const [row] = [...requests.rows.values()];
    const claimedAt = START.add({ hours: 7 * 24 });
    await requests.claim(marketOf(), row!.id, claimedAt, claimedAt.subtract({ minutes: 15 }));

    const read = await http().get(CURRENT).set(as(session));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'executing', waitingPeriodDays: 7 });
    const cancel = await http().delete(CURRENT).set(as(session));
    expect(cancel.status).toBe(409);
    expect(cancel.body).toMatchObject({ code: 'customers.account-deletion-in-progress' });
    expect(cancel.headers['cache-control']).toBe('no-store');
    expect([...requests.rows.values()].map((r) => r.status)).toEqual(['executing']);
  });

  it('answers 403 while the Market has deletion off and 409 with the typed blockers', async () => {
    await boot();
    const session = sessionOf('customer', 8);
    const off = await http().post(PATH).set(as(session)).send({ confirm: true });
    expect(off.status).toBe(403);
    expect(off.body).toMatchObject({ code: 'customers.account-deletion-disabled' });
    expect(off.headers['cache-control']).toBe('no-store');

    turnOn();
    openOrders = 2;
    const blocked = await http().post(PATH).set(as(session)).send({ confirm: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      code: 'customers.account-deletion-blocked',
      details: { blockers: [{ code: 'open-orders', count: 2 }] },
    });
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(requests.rows.size).toBe(0);
  });

  it('needs a closed body with confirm: true', async () => {
    await boot();
    turnOn();
    const session = sessionOf('customer', 9);
    const stray = await http()
      .post(PATH)
      .set(as(session))
      .send({ confirm: true, accountId: id<'Account'>(0xdead) });
    expect(stray.status).toBe(400);
    expect(stray.body).toMatchObject({
      code: 'validation.failed',
      details: { fields: [{ path: 'accountId', code: 'unknown-field' }] },
    });
    for (const body of [{}, { confirm: false }, { confirm: 'true' }]) {
      const res = await http().post(PATH).set(as(session)).send(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'validation.failed' });
      expect((res.body as { details: { fields: { path: string }[] } }).details.fields).toEqual([
        expect.objectContaining({ path: 'confirm' }),
      ]);
    }
    expect(requests.rows.size).toBe(0);
  });
});
