import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { CreateFleetSelectionModel } from '../src/modules/shipping/application/use-cases/create-fleet-selection-model.use-case';
import { SetFleetSelection } from '../src/modules/shipping/application/use-cases/set-fleet-selection.use-case';
import { UpdateFleetSelectionModel } from '../src/modules/shipping/application/use-cases/update-fleet-selection-model.use-case';
import { ViewFleetSelectionHistory } from '../src/modules/shipping/application/use-cases/view-fleet-selection-history.use-case';
import { ViewFleetSelection } from '../src/modules/shipping/application/use-cases/view-fleet-selection.use-case';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The fleet-selection admin routes over HTTP: the real guards and controllers, stubbed use cases.
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

describe.each(TEST_MARKETS)('fleet selection over HTTP in market %s', (code) => {
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
          .overrideProvider(ViewFleetSelection)
          .useValue(stub('view'))
          .overrideProvider(ViewFleetSelectionHistory)
          .useValue(stub('history'))
          .overrideProvider(CreateFleetSelectionModel)
          .useValue(stub('create'))
          .overrideProvider(UpdateFleetSelectionModel)
          .useValue(stub('update'))
          .overrideProvider(SetFleetSelection)
          .useValue(stub('save')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'ship-seed-0001'), {});
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
  const BASE = '/shipping/admin/fleet-selection';
  const MODEL = 'ab01e2a8-0000-7000-8000-000000000001';
  const model = {
    id: MODEL,
    name: 'Cheapest first',
    rule: { kind: 'cheapest' as const },
    version: 1,
    createdAt: START,
    updatedAt: START,
  };
  const selection = {
    version: 4,
    models: [model],
    active: { instant: MODEL, same_day: null, scheduled: null },
    defaultOrder: ['mondapac_drive', 'uber_direct'],
    fleets: [
      {
        fleet: 'mondapac_drive',
        displayName: 'Mondapac Drive',
        enabled: true,
        methods: ['instant'],
        reliability: 90,
        effectiveReliability: 90,
      },
    ],
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok({ ...selection, lastChanged: LAST_CHANGED });
  });
  afterEach(async () => {
    await app?.close();
  });

  it('reads the models, the active model per method and the fleets, with no-store', async () => {
    await boot();

    const res = await call('get', 'admin', BASE, admin());
    const body = res.body as { active: unknown; models: object[]; fleets: object[] };

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as { version: number }).version).toBe(4);
    expect((res.body as { lastChanged: unknown }).lastChanged).toEqual(LAST_CHANGED_BODY);
    expect(body.active).toEqual({ instant: MODEL, same_day: null, scheduled: null });
    expect(body.models[0]).toMatchObject({ id: MODEL, version: 1, rule: { kind: 'cheapest' } });
    expect(body.fleets[0]).toMatchObject({ fleet: 'mondapac_drive', reliability: 90 });
    expect(calls).toEqual([{ name: 'view', input: {} }]);
  });

  it('creates and edits models, and saves the page in one batch, passing the closed body to each use case', async () => {
    await boot();
    const session = admin();
    const rule = { kind: 'fixed_priority', order: ['mondapac_drive', 'zoom2u'] };
    const page = {
      expectedVersion: 4,
      active: { instant: MODEL, same_day: null, scheduled: null },
      reliability: { zoom2u: 70, auspost: null },
    };

    next = ok(model);
    const created = await call('post', 'admin', `${BASE}/models`, session, { name: 'A', rule });
    expect(created.status).toBe(201);
    const updated = await call('put', 'admin', `${BASE}/models/${MODEL}`, session, {
      name: 'B',
      rule,
      expectedVersion: 1,
    });
    expect(updated.status).toBe(200);
    next = ok({ ...selection, lastChanged: LAST_CHANGED });
    const saved = await call('put', 'admin', BASE, session, page);
    expect(saved.status).toBe(200);
    expect((saved.body as { version: number }).version).toBe(4);
    expect(saved.headers['cache-control']).toBe('no-store');

    expect(calls).toEqual([
      { name: 'create', input: { name: 'A', rule } },
      { name: 'update', input: { modelId: MODEL, name: 'B', rule, expectedVersion: 1 } },
      { name: 'save', input: page },
    ]);
  });

  it('lists the history for an admin and passes the paging', async () => {
    await boot();
    const row = { id: 'row-1', ...LAST_CHANGED, fields: ['reliability'] };
    next = ok({ items: [row], next: null });
    const session = admin();
    const read = await call('get', 'admin', `${BASE}/history?limit=5&after=abc`, session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({
      items: [{ id: 'row-1', ...LAST_CHANGED_BODY, fields: ['reliability'] }],
      next: null,
    });
    expect(calls).toEqual([{ name: 'history', input: { after: 'abc', limit: 5 } }]);

    next = err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    const bad = await call('get', 'admin', `${BASE}/history?limit=x`, session);
    expect(bad.status).toBe(400);
    expect(calls.at(-1)).toEqual({ name: 'history', input: { after: null, limit: 'invalid' } });

    // The controller only authenticates; the use case decides (application-layer authorisation).
    next = err({ code: 'access.denied' });
    expect((await call('get', 'admin', `${BASE}/history`, session)).status).toBe(403);
  });

  it('no longer serves the per-method and per-fleet writes', async () => {
    await boot();
    const session = admin();

    expect(
      (await call('put', 'admin', `${BASE}/active/same_day`, session, { modelId: null })).status,
    ).toBe(404);
    expect(
      (await call('put', 'admin', `${BASE}/fleets/zoom2u/reliability`, session, { score: 1 }))
        .status,
    ).toBe(404);
    expect(calls).toEqual([]);
  });

  it('refuses a write without CSRF, with a stray field and not as JSON', async () => {
    await boot();
    const session = admin();
    const page = { expectedVersion: 0, active: {}, reliability: {} };

    expect((await call('put', 'admin', BASE, { cookie: session.cookie }, page)).status).toBe(403);
    const extra = await call('put', 'admin', BASE, session, { ...page, fleet: 'x' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'fleet', code: 'unknown-field' }] },
    });
    const text = await http()
      .post(`${BASE}/models`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('maps a stale page to 409 shipping.fleet-selection-conflict and a missing model to 404', async () => {
    await boot();
    const session = admin();
    const save = () =>
      call('put', 'admin', BASE, session, { expectedVersion: 3, active: {}, reliability: {} });

    next = err({ code: 'shipping.fleet-selection-conflict' });
    const stale = await save();
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ statusCode: 409, code: 'shipping.fleet-selection-conflict' });
    // The winning save: who and when.
    next = err({ code: 'shipping.fleet-selection-conflict', lastChanged: LAST_CHANGED });
    expect((await save()).body).toEqual({
      statusCode: 409,
      code: 'shipping.fleet-selection-conflict',
      details: { lastChanged: LAST_CHANGED_BODY },
    });
    next = err({ code: 'shipping.fleet-model-not-found' });
    expect((await save()).status).toBe(404);
    next = err({ code: 'validation.failed', fields: [{ path: 'active', code: 'format' }] });
    expect((await save()).status).toBe(400);
    next = err({ code: 'access.denied' });
    expect((await save()).status).toBe(403);
  });

  it('maps invalid, unknown model, taken name, stale version, denied and unavailable', async () => {
    await boot();
    const session = admin();
    const put = () =>
      call('put', 'admin', `${BASE}/models/${MODEL}`, session, {
        name: 'B',
        rule: { kind: 'cheapest' },
        expectedVersion: 1,
      });

    next = err({ code: 'validation.failed', fields: [{ path: 'name', code: 'required' }] });
    expect((await put()).status).toBe(400);
    next = err({ code: 'shipping.fleet-model-not-found' });
    const missing = await put();
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ statusCode: 404, code: 'shipping.fleet-model-not-found' });
    next = err({ code: 'shipping.fleet-model-name-taken' });
    expect((await put()).status).toBe(409);
    next = err({ code: 'shipping.fleet-model-conflict', lastChanged: LAST_CHANGED });
    const stale = await put();
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      statusCode: 409,
      code: 'shipping.fleet-model-conflict',
      details: { lastChanged: LAST_CHANGED_BODY },
    });
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
    next = err({ code: 'shipping.unavailable' });
    expect((await put()).status).toBe(503);
  });
});
