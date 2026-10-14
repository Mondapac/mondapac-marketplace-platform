import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ClearCommissionRate } from '../src/modules/commission-payouts/application/use-cases/clear-commission-rate.use-case';
import { SetCommissionRate } from '../src/modules/commission-payouts/application/use-cases/set-commission-rate.use-case';
import { ViewCommissionRate } from '../src/modules/commission-payouts/application/use-cases/view-commission-rate.use-case';
import { ViewOwnLedger } from '../src/modules/commission-payouts/application/use-cases/view-own-ledger.use-case';
import { ViewSellerLedger } from '../src/modules/commission-payouts/application/use-cases/view-seller-ledger.use-case';
import { COMMISSION_PAYOUTS_STATUS } from '../src/modules/commission-payouts/presentation/http-answers';
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

// The commission rate routes (admin) and the ledger routes (admin and seller) over HTTP: the real
// guards and controllers; the use cases are stubs, so this proves the session, the panel
// population, CSRF, the closed bodies, the status of each refusal, the answer shape and
// `no-store`. The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
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

const ledger = (currency: string) => ({
  sellerId: SELLER,
  currency,
  totals: { sales: 1435n, shipping: 500n, commission: 196n, balance: 1739n },
  entries: [
    {
      entryId: id<'LedgerEntry'>(0xd001),
      orderId: id<'Order'>(0xc021),
      sellerOrderId: id<'SellerOrder'>(0xc020),
      orderLineId: id<'OrderLine'>(0xc030),
      kind: 'commission',
      direction: 'debit',
      amount: 150n,
      rateBps: 1500,
      baseAmount: 1000n,
      occurredAt: START,
      recordedAt: START,
    },
  ],
  nextCursor: null,
});

it('maps every refusal code of the commission-payouts routes to its exact status', () => {
  expect(COMMISSION_PAYOUTS_STATUS).toEqual({
    'validation.failed': 400,
    'commission-payouts.seller-not-found': 404,
    'commission-payouts.rate-not-set': 404,
    'commission-payouts.rate-unavailable': 503,
    'commission-payouts.unavailable': 503,
  });
});

describe.each(TEST_MARKETS)('commission and ledger over HTTP in market %s', (code) => {
  const currency = code === 'AU' ? 'AUD' : 'JPY';
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
          .overrideProvider(ViewCommissionRate)
          .useValue(stub('view-rate'))
          .overrideProvider(SetCommissionRate)
          .useValue(stub('set-rate'))
          .overrideProvider(ClearCommissionRate)
          .useValue(stub('clear-rate'))
          .overrideProvider(ViewSellerLedger)
          .useValue(stub('seller-ledger'))
          .overrideProvider(ViewOwnLedger)
          .useValue(stub('own-ledger')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'cp-seed-0001'), {});
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
    method: 'get' | 'post' | 'put' | 'delete',
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
  const RATE = `/commission-payouts/admin/sellers/${SELLER}/commission-rate`;
  const LEDGER = `/commission-payouts/admin/sellers/${SELLER}/ledger`;
  const OWN = '/commission-payouts/seller/ledger';
  const rate = { sellerId: SELLER, rateBps: 1200, source: 'seller', marketRateBps: 1500 };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(rate);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read, set and remove a seller rate, passing the input to the use case', async () => {
    await boot();
    const session = admin();

    const read = await call('get', 'admin', RATE, session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual(rate);
    const set = await call('put', 'admin', RATE, session, { rateBps: 1200 });
    expect(set.status).toBe(200);
    expect(set.body).toEqual(rate);
    const cleared = await call('delete', 'admin', RATE, session);
    expect(cleared.status).toBe(200);
    expect(calls).toEqual([
      { name: 'view-rate', input: { sellerId: SELLER } },
      { name: 'set-rate', input: { sellerId: SELLER, rateBps: 1200 } },
      { name: 'clear-rate', input: { sellerId: SELLER } },
    ]);
  });

  it('refuses a write without CSRF, with a stray field and not as JSON', async () => {
    await boot();
    const session = admin();

    expect(
      (await call('put', 'admin', RATE, { cookie: session.cookie }, { rateBps: 1 })).status,
    ).toBe(403);
    expect((await call('delete', 'admin', RATE, { cookie: session.cookie })).status).toBe(403);
    const extra = await call('put', 'admin', RATE, session, { rateBps: 1, source: 'market' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'source', code: 'unknown-field' }] },
    });
    const text = await http()
      .put(RATE)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('maps invalid, unknown seller, nothing to remove, unavailable and denied', async () => {
    await boot();
    const session = admin();
    const put = () => call('put', 'admin', RATE, session, { rateBps: 1 });

    next = err({ code: 'validation.failed', fields: [{ path: 'rateBps', code: 'range' }] });
    const invalid = await put();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'rateBps', code: 'range' }] },
    });
    next = err({ code: 'commission-payouts.seller-not-found' });
    expect((await put()).status).toBe(404);
    next = err({ code: 'commission-payouts.unavailable' });
    expect((await put()).status).toBe(503);
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
    next = err({ code: 'commission-payouts.rate-not-set' });
    expect((await call('delete', 'admin', RATE, session)).status).toBe(404);
  });

  it('serves the ledger to an admin and to the seller, with money as strings', async () => {
    await boot();
    next = ok(ledger(currency));

    const byAdmin = await call('get', 'admin', `${LEDGER}?limit=10&cursor=abc`, admin());
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.headers['cache-control']).toBe('no-store');
    const own = await call('get', 'seller', OWN, seller());
    expect(own.status).toBe(200);
    expect(own.body).toEqual({
      sellerId: SELLER,
      currency,
      totals: { sales: '1435', shipping: '500', commission: '196', balance: '1739' },
      entries: [
        {
          entryId: id<'LedgerEntry'>(0xd001),
          orderId: id<'Order'>(0xc021),
          sellerOrderId: id<'SellerOrder'>(0xc020),
          orderLineId: id<'OrderLine'>(0xc030),
          kind: 'commission',
          direction: 'debit',
          amount: '150',
          rateBps: 1500,
          baseAmount: '1000',
          occurredAt: START.toString(),
          recordedAt: START.toString(),
        },
      ],
      nextCursor: null,
    });
    expect(calls).toEqual([
      { name: 'seller-ledger', input: { sellerId: SELLER, cursor: 'abc', limit: 10 } },
      { name: 'own-ledger', input: { cursor: undefined, limit: undefined } },
    ]);
  });
});
