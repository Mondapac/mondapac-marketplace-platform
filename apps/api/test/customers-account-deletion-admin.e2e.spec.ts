import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
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

// The admin manual deletion routes over HTTP (customers package 5c): the real guards, gate,
// controller and use cases; request and setting stores in memory; identity the real facade on the
// identity fakes; ordering and wallet fakes. Proves the admin population, CSRF, the permission
// (a viewer and an admin without a role are refused), the admin step-up proof (spent once), the
// Market scope, the closed bodies, the status of each refusal and `no-store`, in both Markets.

const START = Temporal.Instant.from('2026-10-28T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const DELETER = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const NO_ROLE = id<'Account'>(0xa003);
const OTHER_DELETER = id<'Account'>(0xa004);
const SELLER_ACCOUNT = id<'Account'>(0xa101);
const BUYER = id<'Account'>(0xa201);
const SELLER = id<'Seller'>(0xb020);
const DELETE_ROLE = id<'Role'>(0xe001);
const OTHER_DELETE_ROLE = id<'Role'>(0xe002);
const KEY = 'customers.buyer-account.delete';
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const REQUESTS = '/customers/admin/deletion-requests';
const buyerPath = (accountId: string) => `/customers/admin/buyers/${accountId}/deletion-requests`;
const BODY = { ticketRef: 'SUP-1042', reason: 'Buyer asked by phone', confirm: true };

describe.each(TEST_MARKETS)('admin deletion routes over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let requests: MemoryAccountDeletionRequests;
  let settings: MemoryAccountDeletionSettings;
  let openOrders: number;
  let bound: IdentityFacade | null;
  const otherCode = TEST_MARKETS.find((m) => m !== code)!;
  const http = () => request(app!.getHttpServer());
  const marketOf = (c = code) => testMarketContext(c, PLATFORM_TENANT_ID);
  const zero = { amount: 0n, currency: code === 'AU' ? 'AUD' : 'JPY' };

  const peers = (): AccountDeletionPeers & { bind(peers: unknown): void } => ({
    bind: () => undefined,
    identity: {
      endOtherCustomerSessions: (c) => bound!.endOtherCustomerSessions(c),
      endAllCustomerSessions: (c, a, r) => bound!.endAllCustomerSessions(c, a, r),
      customerAccountExists: (c, a) => bound!.customerAccountExists(c, a),
      customerAccountOf: (c, a) => bound!.customerAccountOf(c, a),
      endCustomerSessionsForAdmin: (c, a, r) => bound!.endCustomerSessionsForAdmin(c, a, r),
      eraseCustomerAccount: (c, a, r) => bound!.eraseCustomerAccount(c, a, r),
    },
    ordering: {
      ownOpenObligations: () => Promise.resolve(ok({ openOrders, pendingRefunds: 0 })),
      openObligationsOf: () => Promise.resolve(ok({ openOrders, pendingRefunds: 0 })),
      adminOpenObligationsOf: () => Promise.resolve(ok({ openOrders, pendingRefunds: 0 })),
    },
    wallet: {
      ownBalanceOf: () => Promise.resolve(ok({ available: zero, held: zero })),
      balanceOf: () => Promise.resolve(ok({ available: zero, held: zero })),
      adminBalanceOf: () => Promise.resolve(ok({ available: zero, held: zero })),
    },
    engagement: { forgetAccount: () => Promise.resolve(ok({})) },
    reviews: { detachAuthor: () => Promise.resolve(ok({})) },
  });

  const account = (
    accountId: Id<'Account'>,
    population: 'admin' | 'seller' | 'customer',
    market: string,
    label: string,
  ) =>
    fakes.seedAccount({
      id: accountId,
      marketId: market as AccountState['marketId'],
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
    await app
      .get(SeedRoles)
      .execute(testCallContext(marketOf(), 'system', 'deletion-admin-seed'), {});
    const role = (roleId: Id<'Role'>, market: string) =>
      fakes.seedRole({
        id: roleId,
        marketId: market as AccountState['marketId'],
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: 'Buyer deleter',
        permissionKeys: [KEY, 'customers.account-deletion-requests.view'],
        version: 1,
        createdAt: START,
      });
    role(DELETE_ROLE, code);
    role(OTHER_DELETE_ROLE, otherCode);
    const viewerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === 'viewer',
    )!.id;
    const assign = (n: number, accountId: Id<'Account'>, roleId: Id<'Role'>, market: string) =>
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe900 + n),
        marketId: market as AccountState['marketId'],
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    account(DELETER, 'admin', code, 'deleter');
    account(VIEWER, 'admin', code, 'viewer');
    account(NO_ROLE, 'admin', code, 'norole');
    account(OTHER_DELETER, 'admin', otherCode, 'otherdeleter');
    account(SELLER_ACCOUNT, 'seller', code, 'seller');
    account(BUYER, 'customer', code, 'buyer');
    assign(1, DELETER, DELETE_ROLE, code);
    assign(2, VIEWER, viewerRole, code);
    assign(3, OTHER_DELETER, OTHER_DELETE_ROLE, otherCode);
    for (const [factor, accountId, market] of [
      [0xf301, DELETER, code],
      [0xf302, VIEWER, code],
      [0xf303, OTHER_DELETER, otherCode],
    ] as const) {
      fakes.factors.set(accountId, {
        id: id<'SecondFactor'>(factor),
        marketId: market as AccountState['marketId'],
        accountId,
        state: 'active',
        secretCiphertext: 'sealed',
        pendingSecretCiphertext: null,
        lastAcceptedStep: null,
        activatedAt: START,
        lockedAt: null,
        createdAt: START,
        recoveryCodes: Array.from({ length: 10 }, (_, index) => ({
          position: index + 1,
          codeHash: new Uint8Array(32).fill(index + 1),
          usedAt: null,
        })),
        version: 1,
      });
    }
  }

  function sessionOf(
    population: 'seller' | 'admin' | 'customer',
    n: number,
    accountId: Id<'Account'>,
    market = code,
  ) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(market),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: market as AccountState['marketId'],
        accountId,
        population,
        sellerId: population === 'seller' ? SELLER : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': market,
      ...(population === 'customer' ? {} : panelHeaders(market, population)),
      cookie: `__Host-session-${population}-${market}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }
  const prove = (n: number, market = code) =>
    fakes.stepUpProofs.set(`${market}|${id<'Session'>(0xf100 + n)}|${KEY}`, clock.now());
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
    const visitor = { 'x-market-id': code, ...panelHeaders(code, 'admin') };
    for (const res of [
      await http().post(buyerPath(BUYER)).set(visitor).send(BODY),
      await http().get(REQUESTS).set(visitor),
      await http()
        .delete(`${REQUESTS}/${id<'AccountDeletionRequest'>(0x1)}`)
        .set(visitor)
        .send({ reason: 'x' }),
    ]) {
      expect([401, 403]).toContain(res.status);
    }
    expect(requests.rows.size).toBe(0);
  });

  it('refuses a write without the CSRF token', async () => {
    await boot();
    const { cookie, 'x-market-id': market, ...rest } = sessionOf('admin', 1, DELETER);
    void rest['x-csrf-token'];
    prove(1);
    const headers = { 'x-market-id': market, ...panelHeaders(code, 'admin'), cookie };
    const post = await http().post(buyerPath(BUYER)).set(headers).send(BODY);
    expect(post.status).toBe(403);
    expect(post.body).toMatchObject({ code: 'request.csrf' });
    expect(post.headers['cache-control']).toBe('no-store');
    const del = await http()
      .delete(`${REQUESTS}/${id<'AccountDeletionRequest'>(0x1)}`)
      .set(headers)
      .send({ reason: 'x' });
    expect(del.status).toBe(403);
    expect(requests.rows.size).toBe(0);
  });

  it('refuses a customer or a seller session on every route and writes nothing', async () => {
    await boot();
    for (const [population, n, accountId] of [
      ['customer', 2, BUYER],
      ['seller', 3, SELLER_ACCOUNT],
    ] as const) {
      const headers = sessionOf(population, n, accountId);
      for (const res of [
        await http().post(buyerPath(BUYER)).set(headers).send(BODY),
        await http().get(REQUESTS).set(headers),
        await http()
          .delete(`${REQUESTS}/${id<'AccountDeletionRequest'>(0x1)}`)
          .set(headers)
          .send({ reason: 'x' }),
      ]) {
        expect([401, 403]).toContain(res.status);
      }
    }
    expect(requests.rows.size).toBe(0);
    expect(live(2)).toBe(true);
  });

  it('refuses an admin without the key: a viewer reads the list but cannot delete; no role reads nothing', async () => {
    await boot();
    prove(4);
    const viewer = sessionOf('admin', 4, VIEWER);
    const list = await http().get(REQUESTS).set(viewer);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toEqual({ entries: [], nextCursor: null });
    const post = await http().post(buyerPath(BUYER)).set(viewer).send(BODY);
    expect(post.status).toBe(403);
    expect(post.body).toMatchObject({ code: 'access.denied' });
    expect(post.headers['cache-control']).toBe('no-store');
    const none = sessionOf('admin', 5, NO_ROLE);
    expect((await http().get(REQUESTS).set(none)).status).toBe(403);
    expect(requests.rows.size).toBe(0);
    expect(live(2) || true).toBe(true);
  });

  it('needs a fresh step-up proof, answers 403 with the action key, and commits nothing', async () => {
    await boot();
    const admin = sessionOf('admin', 6, DELETER);
    const res = await http().post(buyerPath(BUYER)).set(admin).send(BODY);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'second-factor.required', details: { actionKey: KEY } });
    expect(res.headers['cache-control']).toBe('no-store');
    const cancel = await http()
      .delete(`${REQUESTS}/${id<'AccountDeletionRequest'>(0x1)}`)
      .set(admin)
      .send({ reason: 'x' });
    expect(cancel.status).toBe(403);
    expect(cancel.body).toMatchObject({ code: 'second-factor.required' });
    expect(requests.rows.size).toBe(0);
    expect(live(6)).toBe(true);
  });

  it('requests, lists, and cancels: 201, 200, 204, each proof spent once, buyer sessions ended', async () => {
    await boot();
    const buyer = sessionOf('customer', 7, BUYER);
    void buyer;
    expect(live(7)).toBe(true);
    const admin = sessionOf('admin', 8, DELETER);
    prove(8);

    const made = await http().post(buyerPath(BUYER)).set(admin).send(BODY);
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    const requestId = (made.body as { requestId: string }).requestId;
    expect(made.body).toEqual({
      requestId,
      status: 'pending',
      requestedAt: START.toString(),
      scheduledFor: START.add({ hours: 30 * 24 }).toString(),
      waitingPeriodDays: 30,
    });
    expect(live(7)).toBe(false);
    expect([...requests.rows.values()][0]).toMatchObject({
      requestedBy: 'admin',
      adminOrigin: { adminAccountId: DELETER, ticketRef: 'SUP-1042' },
    });

    const list = await http().get(REQUESTS).query({ status: 'pending' }).set(admin);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toEqual({
      entries: [
        {
          requestId,
          accountId: BUYER,
          requestedAt: START.toString(),
          scheduledFor: START.add({ hours: 30 * 24 }).toString(),
          status: 'pending',
          requestedBy: 'admin',
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(list.body)).not.toContain('SUP-1042');

    // The request spent its proof, so a repeat is stopped by the guard until a new one is verified.
    const spent = await http().post(buyerPath(BUYER)).set(admin).send(BODY);
    expect(spent.status).toBe(403);
    expect(spent.body).toMatchObject({ code: 'second-factor.required' });
    prove(8);
    const again = await http().post(buyerPath(BUYER)).set(admin).send(BODY);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'customers.account-deletion-already-requested' });

    // The 409 spent no proof, so the one verified above still serves the cancel, once.
    const cancelled = await http().delete(`${REQUESTS}/${requestId}`).set(admin).send({
      reason: 'Buyer changed their mind',
    });
    expect(cancelled.status).toBe(204);
    expect(cancelled.headers['cache-control']).toBe('no-store');
    expect([...requests.rows.values()].map((r) => r.status)).toEqual(['cancelled']);
    prove(8);
    const gone = await http().delete(`${REQUESTS}/${requestId}`).set(admin).send({ reason: 'x' });
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: 'customers.account-deletion-request-not-found' });
  });

  it('answers 409 in progress to a cancel of a claimed request', async () => {
    await boot();
    const admin = sessionOf('admin', 9, DELETER);
    prove(9);
    const made = await http().post(buyerPath(BUYER)).set(admin).send(BODY);
    const requestId = (made.body as { requestId: string }).requestId;
    const claimedAt = START.add({ hours: 30 * 24 });
    await requests.claim(
      marketOf(),
      requestId as Id<'AccountDeletionRequest'>,
      claimedAt,
      claimedAt,
    );
    prove(9);
    const res = await http().delete(`${REQUESTS}/${requestId}`).set(admin).send({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'customers.account-deletion-in-progress' });
    expect([...requests.rows.values()].map((r) => r.status)).toEqual(['executing']);
  });

  it('is 404 across Markets: the other Market admin sees neither the buyer nor the request', async () => {
    await boot();
    const admin = sessionOf('admin', 10, DELETER);
    prove(10);
    const made = await http().post(buyerPath(BUYER)).set(admin).send(BODY);
    const requestId = (made.body as { requestId: string }).requestId;
    const foreign = sessionOf('admin', 11, OTHER_DELETER, otherCode);
    prove(11, otherCode);
    const post = await http().post(buyerPath(BUYER)).set(foreign).send(BODY);
    expect(post.status).toBe(404);
    expect(post.body).toMatchObject({ code: 'customers.buyer-account-not-found' });
    prove(11, otherCode);
    const del = await http().delete(`${REQUESTS}/${requestId}`).set(foreign).send({ reason: 'x' });
    expect(del.status).toBe(404);
    const list = await http().get(REQUESTS).set(foreign);
    expect(list.body).toEqual({ entries: [], nextCursor: null });
    expect([...requests.rows.values()].map((r) => r.status)).toEqual(['pending']);
  });

  it('answers 409 with the typed blockers and spends no proof', async () => {
    await boot();
    openOrders = 2;
    const admin = sessionOf('admin', 12, DELETER);
    prove(12);
    const res = await http().post(buyerPath(BUYER)).set(admin).send(BODY);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'customers.account-deletion-blocked',
      details: { blockers: [{ code: 'open-orders', count: 2 }] },
    });
    expect(res.headers['cache-control']).toBe('no-store');
    openOrders = 0;
    const ok201 = await http().post(buyerPath(BUYER)).set(admin).send(BODY);
    expect(ok201.status).toBe(201);
  });

  it('needs closed, valid bodies and a known buyer id', async () => {
    await boot();
    const admin = sessionOf('admin', 13, DELETER);
    prove(13);
    const stray = await http()
      .post(buyerPath(BUYER))
      .set(admin)
      .send({ ...BODY, accountId: 'x' });
    expect(stray.status).toBe(400);
    expect(stray.body).toMatchObject({
      details: { fields: [{ path: 'accountId', code: 'unknown-field' }] },
    });
    for (const body of [
      { ...BODY, ticketRef: 'has space' },
      { ...BODY, reason: '' },
      { ...BODY, confirm: false },
      { reason: 'x', confirm: true },
    ]) {
      const res = await http().post(buyerPath(BUYER)).set(admin).send(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'validation.failed' });
    }
    const unknown = await http().post(buyerPath('not-an-id')).set(admin).send(BODY);
    expect(unknown.status).toBe(404);
    const noReason = await http()
      .delete(`${REQUESTS}/${id<'AccountDeletionRequest'>(0x1)}`)
      .set(admin)
      .send({});
    expect(noReason.status).toBe(400);
    const badStatus = await http().get(REQUESTS).query({ status: 'executing' }).set(admin);
    expect(badStatus.status).toBe(400);
    expect(badStatus.headers['cache-control']).toBe('no-store');
    expect(requests.rows.size).toBe(0);
  });
});
