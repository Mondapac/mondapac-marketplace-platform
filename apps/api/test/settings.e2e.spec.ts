import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { ChangeMarketSetting } from '../src/modules/settings/application/use-cases/change-market-setting.use-case';
import { ReadListPaging } from '../src/modules/settings/application/use-cases/read-list-paging.use-case';
import { ViewMarketSettings } from '../src/modules/settings/application/use-cases/view-market-settings.use-case';
import { SETTINGS_STATUS } from '../src/modules/settings/presentation/http-answers';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The settings routes over HTTP: the real guards and controllers; the use cases are stubs, so this
// proves the session, the panel population, Origin and CSRF, the closed body, the status of each
// refusal, the answer shape and `no-store`, and the two panel reads of List paging. The use cases
// have their own spec (settings-use-cases.spec.ts) and the store its own database spec.

const START = Temporal.Instant.from('2026-11-03T21:00:00Z');
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
const SETTINGS = '/settings/admin/market-settings';
const ADMIN_PAGING = '/settings/admin/list-paging';
const SELLER_PAGING = '/settings/seller/list-paging';
const LIST = [{ code: 'list-paging', value: 'pages', version: 0, updatedAt: null }];
const CHANGED = {
  code: 'list-paging',
  value: 'prev-next',
  version: 1,
  updatedAt: START.toString(),
};

it('maps every refusal code of the settings routes to its exact status', () => {
  expect(SETTINGS_STATUS).toEqual({
    'validation.failed': 400,
    'settings.conflict': 409,
  });
});

describe.each(TEST_MARKETS)('settings over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  let actorKinds: string[];
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
          .overrideProvider(ViewMarketSettings)
          .useValue(stub('view'))
          .overrideProvider(ChangeMarketSetting)
          .useValue(stub('change'))
          .overrideProvider(ReadListPaging)
          .useValue(stub('paging')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'settings-seed-01'), {});
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
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe001),
      marketId,
      accountId: SELLER_ACCOUNT,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
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

  const call = (
    method: 'get' | 'put',
    path: string,
    population: 'seller' | 'admin',
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    actorKinds = [];
    next = ok(LIST);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read the settings and change one, passing the body to the use case', async () => {
    await boot();
    const session = sessionOf('admin', 2);

    const read = await call('get', SETTINGS, 'admin', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({
      settings: [{ code: 'list-paging', value: 'pages', version: 0, updatedAt: null }],
    });

    next = ok(CHANGED);
    const set = await call('put', SETTINGS, 'admin', session, {
      code: 'list-paging',
      value: 'prev-next',
      expectedVersion: 0,
    });
    expect(set.status).toBe(200);
    expect(set.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual([
      { name: 'view', input: {} },
      { name: 'change', input: { code: 'list-paging', value: 'prev-next', expectedVersion: 0 } },
    ]);
  });

  it('answers List paging to a signed-in admin and to a signed-in seller, each on its own route', async () => {
    await boot();
    next = ok('pages');

    const admin = await call('get', ADMIN_PAGING, 'admin', sessionOf('admin', 2));
    const seller = await call('get', SELLER_PAGING, 'seller', sessionOf('seller', 3));

    expect(admin.status).toBe(200);
    expect(seller.status).toBe(200);
    expect(admin.headers['cache-control']).toBe('no-store');
    expect(seller.headers['cache-control']).toBe('no-store');
    expect(admin.body).toEqual({ listPaging: 'pages' });
    expect(seller.body).toEqual({ listPaging: 'pages' });
    expect(actorKinds).toEqual(['authenticated', 'authenticated']);
  });

  it('reads only the right population: no session or the other panel session is an anonymous actor', async () => {
    await boot();
    await call('get', ADMIN_PAGING, 'admin', {});
    await call('get', SELLER_PAGING, 'seller', {});
    await http()
      .get(ADMIN_PAGING)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...sessionOf('seller', 4) });
    // The real gate refuses the anonymous actor (access.unauthenticated); the stub only records it.
    expect(actorKinds).toEqual(['anonymous', 'anonymous', 'anonymous']);
  });

  it('refuses a change from a foreign Origin or a cross-site fetch', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const body = { code: 'list-paging', value: 'pages', expectedVersion: 0 };
    const foreign = await http()
      .put(SETTINGS)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...session,
        origin: 'https://evil.example',
      })
      .send(body);
    const crossSite = await http()
      .put(SETTINGS)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...session,
        'sec-fetch-site': 'cross-site',
      })
      .send(body);
    expect(foreign.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses a change without CSRF, with a stray field and not as JSON', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const body = { code: 'list-paging', value: 'pages', expectedVersion: 0 };

    expect((await call('put', SETTINGS, 'admin', { cookie: session.cookie }, body)).status).toBe(
      403,
    );
    const extra = await call('put', SETTINGS, 'admin', session, { ...body, updatedBy: 'x' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'updatedBy', code: 'unknown-field' }] },
    });
    const text = await http()
      .put(SETTINGS)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('maps invalid, conflict and denied', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const put = () =>
      call('put', SETTINGS, 'admin', session, {
        code: 'list-paging',
        value: 'pages',
        expectedVersion: 0,
      });

    next = err({ code: 'validation.failed', fields: [{ path: 'value', code: 'value' }] });
    const invalid = await put();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ details: { fields: [{ path: 'value', code: 'value' }] } });
    next = err({ code: 'settings.conflict' });
    const conflict = await put();
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ statusCode: 409, code: 'settings.conflict' });
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
  });
});
