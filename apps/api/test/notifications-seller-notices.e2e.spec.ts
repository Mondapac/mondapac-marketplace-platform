import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { CountOwnUnreadNotices } from '../src/modules/notifications/application/use-cases/count-own-unread-notices.use-case';
import { ListOwnNotices } from '../src/modules/notifications/application/use-cases/list-own-notices.use-case';
import { MarkOwnNoticesRead } from '../src/modules/notifications/application/use-cases/mark-own-notices-read.use-case';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller's in-app notice routes over HTTP: the real guards and controller; the use cases are
// stubs, so this proves the session, the seller population, CSRF and the panel origin on the
// POSTs, what reaches each use case, the status of each refusal and `no-store`. The use cases have
// their own spec.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const SELLER_ACCOUNT = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const PATH = '/notifications/seller/notices';
const NOTICE_ID = '01990000-0000-7000-8000-00000000c0de';
const NOTICE = {
  id: NOTICE_ID,
  kind: 'seller.order-paid',
  params: { sellerOrderId: '01990000-0000-7000-8000-000000000021', items: 3 },
  createdAt: '2026-10-17T10:00:00Z',
  read: false,
};

describe.each(TEST_MARKETS)('seller notices over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown; actor: string }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const stub = (name: string) => ({
    execute: (context: { actor: { kind: string; population?: string } }, input: unknown) => {
      calls.push({ name, input, actor: context.actor.population ?? context.actor.kind });
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
          .overrideProvider(ListOwnNotices)
          .useValue(stub('list'))
          .overrideProvider(CountOwnUnreadNotices)
          .useValue(stub('count'))
          .overrideProvider(MarkOwnNoticesRead)
          .useValue(stub('mark')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'notice-seed-0001'), {});
    for (const [accountId, population, label] of [
      [ADMIN, 'admin', 'admin'],
      [SELLER_ACCOUNT, 'seller', 'seller'],
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
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 1,
      createdAt: START,
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf001),
      marketId,
      accountId: SELLER_ACCOUNT,
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
        accountId: population === 'seller' ? SELLER_ACCOUNT : ADMIN,
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

  const get = (path: string, population: 'seller' | 'admin', headers: Record<string, string>) =>
    http()
      .get(`${PATH}${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });
  const post = (path: string, population: 'seller' | 'admin', headers: Record<string, string>) =>
    http()
      .post(`${PATH}${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lists, pages and counts for the signed-in seller-side member', async () => {
    await boot();
    const session = sessionOf('seller', 1);

    next = ok({ items: [NOTICE], next: null });
    const page = await get('', 'seller', session);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toEqual({ items: [NOTICE], next: null });
    expect((await get(`?before=${NOTICE_ID}&show=read`, 'seller', session)).status).toBe(200);

    next = ok({ unread: 1, newest: NOTICE });
    const unread = await get('/unread-count', 'seller', session);
    expect(unread.status).toBe(200);
    expect(unread.headers['cache-control']).toBe('no-store');
    expect(unread.body).toEqual({ unread: 1, newest: NOTICE });

    expect(calls).toEqual([
      { name: 'list', input: {}, actor: 'seller' },
      { name: 'list', input: { before: NOTICE_ID, show: 'read' }, actor: 'seller' },
      { name: 'count', input: {}, actor: 'seller' },
    ]);
  });

  it('marks one or all read with the CSRF token', async () => {
    await boot();
    const session = sessionOf('seller', 1);
    next = ok({ marked: 1 });

    const one = await post(`/${NOTICE_ID}/read`, 'seller', session);
    expect(one.status).toBe(200);
    expect(one.headers['cache-control']).toBe('no-store');
    expect(one.body).toEqual({ marked: 1 });
    expect((await post('/read-all', 'seller', session)).status).toBe(200);
    expect(calls).toEqual([
      { name: 'mark', input: { target: { id: NOTICE_ID } }, actor: 'seller' },
      { name: 'mark', input: { target: { all: true } }, actor: 'seller' },
    ]);
  });

  it('refuses a POST without CSRF or from outside the seller panel', async () => {
    await boot();
    const session = sessionOf('seller', 1);

    expect((await post('/read-all', 'seller', { cookie: session.cookie })).status).toBe(403);
    const foreign = await http()
      .post(`${PATH}/read-all`)
      .set({ 'x-market-id': code, ...session });
    expect(foreign.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses without a session, and with an admin session', async () => {
    await boot();
    // No session reaches the use case as the anonymous actor, which its own-resources rule refuses.
    next = err({ code: 'access.unauthenticated' });
    expect((await get('/unread-count', 'seller', {})).status).toBe(401);
    calls = [];
    // An admin session is not read on a seller route: the call is anonymous, so refused.
    const admin = sessionOf('admin', 2);
    const asAdmin = await get('/unread-count', 'seller', { cookie: admin.cookie });
    expect(asAdmin.status).toBe(401);
    expect(calls).toEqual([{ name: 'count', input: {}, actor: 'anonymous' }]);
  });

  it('maps not found, invalid and denied', async () => {
    await boot();
    const session = sessionOf('seller', 1);

    next = err({ code: 'notifications.notice-not-found' });
    const missing = await post(`/${NOTICE_ID}/read`, 'seller', session);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ statusCode: 404, code: 'notifications.notice-not-found' });
    next = err({ code: 'validation.failed', fields: [{ path: 'id', code: 'format' }] });
    const invalid = await post('/nope/read', 'seller', session);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ details: { fields: [{ path: 'id' }] } });
    next = err({ code: 'access.denied' });
    expect((await get('', 'seller', session)).status).toBe(403);
  });
});
