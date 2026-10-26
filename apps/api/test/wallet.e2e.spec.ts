import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SetWalletStatus } from '../src/modules/wallet/application/use-cases/set-wallet-status.use-case';
import { ViewMyHistory } from '../src/modules/wallet/application/use-cases/view-my-history.use-case';
import { ViewMyWallet } from '../src/modules/wallet/application/use-cases/view-my-wallet.use-case';
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
    'wallet.cannot-turn-off-with-history': 409,
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
  }

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
  const admin = () => sessionOf('admin', 2);

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

  const settings = { status: 'paused', reason: 'wind-down', updatedAt: START };

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
    });
    const set = await asAdmin('put', session, { status: 'paused', reasonCode: 'wind-down' });
    expect(set.status).toBe(200);
    expect(calls).toEqual([
      { name: 'view-settings', input: {} },
      { name: 'set-status', input: { status: 'paused', reasonCode: 'wind-down' } },
    ]);
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
