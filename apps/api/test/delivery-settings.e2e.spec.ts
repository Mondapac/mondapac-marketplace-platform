import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { SetDeliverySettings } from '../src/modules/shipping/application/use-cases/set-delivery-settings.use-case';
import { SetSellerDeliveryMethods } from '../src/modules/shipping/application/use-cases/set-seller-delivery-methods.use-case';
import { ViewDeliverySettingsHistory } from '../src/modules/shipping/application/use-cases/view-delivery-settings-history.use-case';
import { ViewDeliverySettings } from '../src/modules/shipping/application/use-cases/view-delivery-settings.use-case';
import { ViewSellerDeliveryMethods } from '../src/modules/shipping/application/use-cases/view-seller-delivery-methods.use-case';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The delivery-settings admin routes over HTTP: the real guards and controllers, stubbed use cases.
// This proves the admin session, CSRF, the closed bodies, the status of each refusal, the answer
// shape and `no-store`. The use cases have their own specs.

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
const LAST_CHANGED = {
  at: Temporal.Instant.from('2026-10-13T09:30:00Z'),
  byDisplayName: 'Sara K.',
  byKind: 'member',
} as const;
const LAST_CHANGED_BODY = {
  at: '2026-10-13T09:30:00Z',
  byDisplayName: 'Sara K.',
  byKind: 'member',
};
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('delivery settings over HTTP in market %s', (code) => {
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
          .overrideProvider(ViewDeliverySettings)
          .useValue(stub('view'))
          .overrideProvider(ViewDeliverySettingsHistory)
          .useValue(stub('history'))
          .overrideProvider(SetDeliverySettings)
          .useValue(stub('save'))
          .overrideProvider(ViewSellerDeliveryMethods)
          .useValue(stub('view-seller'))
          .overrideProvider(SetSellerDeliveryMethods)
          .useValue(stub('save-seller')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'dset-seed-0001'), {});
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
  const admin = () => sessionOf('admin', 2);

  const call = (
    method: 'get' | 'post' | 'put',
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
  const BASE = '/shipping/admin';
  const SETTINGS_URL = `${BASE}/delivery-settings`;
  const SELLER_URL = `${BASE}/sellers/${SELLER}/delivery-methods`;
  const view = {
    settings: {
      enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
      sameDayCutoffMinutes: 630,
      scheduledDaysAhead: 5,
      scheduledWindowMinutes: 90,
      margin: { kind: 'percent' as const, basisPoints: 1000 },
      roundingStepMinor: 5,
      version: 3,
    },
    currency: code === 'AU' ? 'AUD' : 'JPY',
    marketZone: code === 'AU' ? 'Australia/Brisbane' : 'Asia/Tokyo',
  };
  const request_ = {
    enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
    sameDayCutoff: '10:30',
    scheduledDaysAhead: 5,
    scheduledWindowMinutes: 90,
    margin: { kind: 'percent', basisPoints: 1000 },
    roundingStepMinor: 5,
    expectedVersion: 3,
  };
  const sellerView = {
    sellerId: SELLER,
    supported: ['pickup', 'scheduled'],
    platformEnabled: { pickup: true, instant: true, same_day: false, scheduled: true },
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok({ ...view, lastChanged: LAST_CHANGED });
  });
  afterEach(async () => {
    await app?.close();
  });

  it('reads the settings with the cut-off as HH:MM, the margin, the steps and no-store', async () => {
    await boot();

    const res = await call('get', 'admin', SETTINGS_URL, admin());

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
      sameDayCutoff: '10:30',
      scheduledDaysAhead: 5,
      scheduledWindowMinutes: 90,
      margin: { kind: 'percent', basisPoints: 1000 },
      roundingStepMinor: 5,
      version: 3,
      currency: view.currency,
      marketZone: view.marketZone,
      roundingSteps: [1, 5, 10, 50, 100],
      lastChanged: LAST_CHANGED_BODY,
    });
    expect(calls).toEqual([{ name: 'view', input: {} }]);
  });

  it('saves the whole set, passing the closed body to the use case', async () => {
    await boot();

    const res = await call('put', 'admin', SETTINGS_URL, admin(), request_);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual([{ name: 'save', input: request_ }]);
  });

  it('lists the history for an admin and passes the paging', async () => {
    await boot();
    const row = { id: 'row-1', ...LAST_CHANGED, fields: ['sameDayCutoffMinutes'] };
    next = ok({ items: [row], next: null });
    const session = admin();
    const read = await call('get', 'admin', `${SETTINGS_URL}/history?limit=5&after=abc`, session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({
      items: [{ id: 'row-1', ...LAST_CHANGED_BODY, fields: ['sameDayCutoffMinutes'] }],
      next: null,
    });
    expect(calls).toEqual([{ name: 'history', input: { after: 'abc', limit: 5 } }]);

    next = err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    const bad = await call('get', 'admin', `${SETTINGS_URL}/history?limit=x`, session);
    expect(bad.status).toBe(400);
    expect(calls.at(-1)).toEqual({ name: 'history', input: { after: null, limit: 'invalid' } });

    // The controller only authenticates; the use case decides (application-layer authorisation).
    next = err({ code: 'access.denied' });
    expect((await call('get', 'admin', `${SETTINGS_URL}/history`, session)).status).toBe(403);
  });

  it('reads and sets the methods of a seller', async () => {
    await boot();
    const session = admin();
    next = ok(sellerView);

    const read = await call('get', 'admin', SELLER_URL, session);
    const saved = await call('put', 'admin', SELLER_URL, session, {
      supported: ['pickup', 'scheduled'],
    });

    expect(read.status).toBe(200);
    expect(read.body).toEqual(sellerView);
    expect(saved.status).toBe(200);
    expect(calls).toEqual([
      { name: 'view-seller', input: { sellerId: SELLER } },
      { name: 'save-seller', input: { sellerId: SELLER, supported: ['pickup', 'scheduled'] } },
    ]);
  });

  it('refuses a write without CSRF, with a stray field and not as JSON', async () => {
    await boot();
    const session = admin();

    expect(
      (await call('put', 'admin', SETTINGS_URL, { cookie: session.cookie }, request_)).status,
    ).toBe(403);
    const extra = await call('put', 'admin', SETTINGS_URL, session, { ...request_, margin2: 1 });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'margin2', code: 'unknown-field' }] },
    });
    const seller = await call('put', 'admin', SELLER_URL, session, { supported: [], extra: 1 });
    expect(seller.status).toBe(400);
    const text = await http()
      .put(SETTINGS_URL)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('keeps a seller session out of the admin routes', async () => {
    await boot();

    const res = await call('put', 'seller', SETTINGS_URL, sessionOf('seller', 1), request_);

    expect([401, 403]).toContain(res.status);
    expect(calls).toEqual([]);
  });

  it('maps invalid, stale version, unknown seller, denied and unavailable', async () => {
    await boot();
    const session = admin();
    const put = () => call('put', 'admin', SETTINGS_URL, session, request_);

    next = err({ code: 'validation.failed', fields: [{ path: 'sameDayCutoff', code: 'format' }] });
    const invalid = await put();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      details: { fields: [{ path: 'sameDayCutoff', code: 'format' }] },
    });
    next = err({ code: 'shipping.delivery-settings-conflict' });
    const stale = await put();
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ statusCode: 409, code: 'shipping.delivery-settings-conflict' });
    // The winning save: who and when.
    next = err({ code: 'shipping.delivery-settings-conflict', lastChanged: LAST_CHANGED });
    expect((await put()).body).toEqual({
      statusCode: 409,
      code: 'shipping.delivery-settings-conflict',
      details: { lastChanged: LAST_CHANGED_BODY },
    });
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
    next = err({ code: 'shipping.seller-not-found' });
    expect((await call('get', 'admin', SELLER_URL, session)).status).toBe(404);
    next = err({ code: 'shipping.unavailable' });
    expect((await call('get', 'admin', SELLER_URL, session)).status).toBe(503);
  });
});
