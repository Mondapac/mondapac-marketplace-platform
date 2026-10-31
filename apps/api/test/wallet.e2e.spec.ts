import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SetWalletStatus } from '../src/modules/wallet/application/use-cases/set-wallet-status.use-case';
import { ViewMyHistory } from '../src/modules/wallet/application/use-cases/view-my-history.use-case';
import { ViewMyWallet } from '../src/modules/wallet/application/use-cases/view-my-wallet.use-case';
import { ViewWalletSettingsHistory } from '../src/modules/wallet/application/use-cases/view-wallet-settings-history.use-case';
import { ViewWalletSettings } from '../src/modules/wallet/application/use-cases/view-wallet-settings.use-case';
import { WALLET_STATUS } from '../src/modules/wallet/presentation/http-answers';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The wallet routes over HTTP: the real guards and controllers; the use cases are stubs, so this
// proves the session, the population of each route, CSRF, the closed body, the status of each
// refusal, the answer shape (money as strings) and `no-store`. The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-25T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xa101);
const ADMIN = id<'Account'>(0xa001);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the wallet routes to its exact status', () => {
  expect(WALLET_STATUS).toEqual({
    'validation.failed': 400,
    'wallet.disabled': 404,
    'wallet.unavailable': 503,
    'wallet.busy': 409,
    'wallet.settings-conflict': 409,
    'wallet.cannot-turn-off-with-history': 409,
    'second-factor.required': 403,
    'second-factor.enrolment-required': 403,
    'wallet.paused': 409,
    'wallet.frozen': 409,
    'wallet.cap-exceeded': 409,
    'wallet.account-not-active': 409,
    'idempotency.key-reused': 409,
    'wallet.credit-request-not-found': 404,
    'wallet.customer-not-found': 404,
    'wallet.credit-request-decided': 409,
    'wallet.credit-request-expired': 409,
    'wallet.approver-is-requester': 403,
  });
});

describe.each(TEST_MARKETS)('wallet over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
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
          .overrideProvider(ViewMyWallet)
          .useValue(stub('my-wallet'))
          .overrideProvider(ViewMyHistory)
          .useValue(stub('my-history'))
          .overrideProvider(ViewWalletSettings)
          .useValue(stub('view-settings'))
          .overrideProvider(ViewWalletSettingsHistory)
          .useValue(stub('history'))
          .overrideProvider(SetWalletStatus)
          .useValue(stub('set-status')),
    }));
    for (const [accountId, population, label] of [
      [CUSTOMER, 'customer', 'shopper'],
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
    // The admin's active second factor, for the admin step-up of the switch (issue #491).
    fakes.factors.set(ADMIN, {
      id: id<'SecondFactor'>(0xf301),
      marketId,
      accountId: ADMIN,
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

  /** A fresh step-up proof of the admin session for the switch (identity's verify route). */
  const proveSwitch = (n: number) =>
    fakes.stepUpProofs.set(
      `${code}|${id<'Session'>(0xf100 + n)}|wallet.settings.change`,
      clock.now(),
    );

  function sessionOf(population: 'customer' | 'admin', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      testMarketContext(code, PLATFORM_TENANT_ID),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId: population === 'customer' ? CUSTOMER : ADMIN,
        population,
        sellerId: null,
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
  const customer = () => sessionOf('customer', 1);
  const admin = () => {
    const session = sessionOf('admin', 2);
    proveSwitch(2);
    return session;
  };

  const asAdmin = (method: 'get' | 'put', headers: Record<string, string>, payload?: unknown) => {
    const req = http()
      [method]('/wallet/admin/settings')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };
  const asCustomer = (path: string, headers: Record<string, string>) =>
    http()
      .get(path)
      .set({ 'x-market-id': code, ...headers });

  const LAST_CHANGED = { at: START, byDisplayName: 'Sara K.', byKind: 'member' } as const;
  const LAST_CHANGED_BODY = { at: START.toString(), byDisplayName: 'Sara K.', byKind: 'member' };
  const settings = {
    status: 'paused',
    reason: 'wind-down',
    updatedAt: START,
    version: 4,
    lastChanged: LAST_CHANGED,
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(settings);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read and set the switch, passing the input to the use case', async () => {
    await boot();
    const session = admin();
    const read = await asAdmin('get', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({
      status: 'paused',
      reason: 'wind-down',
      updatedAt: START.toString(),
      version: 4,
      lastChanged: LAST_CHANGED_BODY,
    });
    const set = await asAdmin('put', session, {
      status: 'paused',
      reasonCode: 'wind-down',
      expectedVersion: 4,
    });
    expect(set.status).toBe(200);
    expect(calls).toEqual([
      { name: 'view-settings', input: {} },
      {
        name: 'set-status',
        input: { status: 'paused', reasonCode: 'wind-down', expectedVersion: 4 },
      },
    ]);
  });

  it('lists the history for an admin and passes the paging', async () => {
    await boot();
    next = ok({
      items: [{ id: 'row-1', ...LAST_CHANGED, fields: ['reason', 'status'] }],
      next: null,
    });
    const session = admin();
    const get = (path: string) =>
      http()
        .get(path)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session });
    const read = await get('/wallet/admin/settings/history?limit=5&after=abc');
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({
      items: [{ id: 'row-1', ...LAST_CHANGED_BODY, fields: ['reason', 'status'] }],
      next: null,
    });
    expect(calls).toEqual([{ name: 'history', input: { after: 'abc', limit: 5 } }]);

    next = err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    expect((await get('/wallet/admin/settings/history?limit=x')).status).toBe(400);
    expect(calls.at(-1)).toEqual({ name: 'history', input: { after: null, limit: 'invalid' } });

    // The controller only authenticates; the use case decides (application-layer authorisation).
    next = err({ code: 'access.denied' });
    expect((await get('/wallet/admin/settings/history')).status).toBe(403);
  });

  it('refuses the switch without a fresh step-up proof of the session (issue #491)', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const put = () => asAdmin('put', session, { status: 'active' });
    const refused = await put();
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'wallet.settings.change' },
    });
    proveSwitch(2);
    clock.advance(Temporal.Duration.from({ minutes: 5 }));
    expect((await put()).status).toBe(403);
    proveSwitch(2);
    expect((await put()).status).toBe(200);
    // The read needs no proof.
    fakes.stepUpProofs.clear();
    expect((await asAdmin('get', session)).status).toBe(200);
    // The use case's own refusal carries the action key too.
    proveSwitch(2);
    next = err({ code: 'second-factor.required', actionKey: 'wallet.settings.change' });
    expect((await put()).body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'wallet.settings.change' },
    });
    expect(calls.map((call) => call.name)).toEqual(['set-status', 'view-settings', 'set-status']);
  });

  it('refuses a write without CSRF, with a stray field and not as JSON', async () => {
    await boot();
    const session = admin();
    expect((await asAdmin('put', { cookie: session.cookie }, { status: 'active' })).status).toBe(
      403,
    );
    const extra = await asAdmin('put', session, { status: 'active', enabled: true });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'enabled', code: 'unknown-field' }] },
    });
    const text = await http()
      .put('/wallet/admin/settings')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('maps invalid, history and denied', async () => {
    await boot();
    const session = admin();
    const put = () => asAdmin('put', session, { status: 'off' });
    next = err({ code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'required' }] });
    const invalid = await put();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'reasonCode', code: 'required' }] },
    });
    next = err({ code: 'wallet.cannot-turn-off-with-history' });
    expect((await put()).status).toBe(409);
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
  });

  it('answers a stale save as 409 wallet.settings-conflict and the guard does not spend the proof', async () => {
    await boot();
    const session = admin();
    next = err({ code: 'wallet.settings-conflict' });
    const stale = await asAdmin('put', session, { status: 'active', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ statusCode: 409, code: 'wallet.settings-conflict' });
    // The winning change: who and when.
    next = err({ code: 'wallet.settings-conflict', lastChanged: LAST_CHANGED });
    const named = await asAdmin('put', session, { status: 'active', expectedVersion: 1 });
    expect(named.body).toEqual({
      statusCode: 409,
      code: 'wallet.settings-conflict',
      details: { lastChanged: LAST_CHANGED_BODY },
    });
    // The route guard only reads the proof; the use case spends it (and did not, here).
    expect(fakes.stepUpProofs.size).toBe(1);
    expect(calls).toEqual([
      { name: 'set-status', input: { status: 'active', expectedVersion: 1 } },
      { name: 'set-status', input: { status: 'active', expectedVersion: 1 } },
    ]);
  });

  it('serves the customer balance and history with money as strings, no-store, and wallet.disabled as 404', async () => {
    await boot();
    const session = customer();
    next = ok({
      currency: code === 'AU' ? 'AUD' : 'JPY',
      available: 1200n,
      held: 300n,
      marketStatus: 'active',
      expiringSoon: [{ expiresAt: START, amount: 700n }],
    });
    const me = await asCustomer('/wallet/me', session);
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.body).toEqual({
      currency: code === 'AU' ? 'AUD' : 'JPY',
      available: '1200',
      held: '300',
      marketStatus: 'active',
      expiringSoon: [{ expiresAt: START.toString(), amount: '700' }],
    });
    next = ok({
      currency: 'AUD',
      entries: [
        {
          journalId: id<'WalletJournal'>(0xd001),
          kind: 'hold',
          amount: -200n,
          reasonCode: 'order-hold',
          orderId: id<'Order'>(0xc021),
          createdAt: START,
        },
      ],
      nextCursor: null,
    });
    const history = await asCustomer('/wallet/me/history?limit=5&cursor=abc', session);
    expect(history.status).toBe(200);
    expect((history.body as { entries: unknown[] }).entries[0]).toMatchObject({
      kind: 'hold',
      amount: '-200',
    });
    expect(calls.slice(-1)).toEqual([{ name: 'my-history', input: { cursor: 'abc', limit: 5 } }]);
    next = err({ code: 'wallet.disabled' });
    expect((await asCustomer('/wallet/me', session)).status).toBe(404);
    expect((await asCustomer('/wallet/me/history', session)).status).toBe(404);
  });

  it('refuses a visitor without a session', async () => {
    await boot();
    // The real gate answers an anonymous actor with access.unauthenticated; the stub stands in.
    next = err({ code: 'access.unauthenticated' });
    const res = await http().get('/wallet/me').set({ 'x-market-id': code });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'access.unauthenticated' });
  });
});
