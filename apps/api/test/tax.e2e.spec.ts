import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ActivateTaxStrategy } from '../src/modules/tax/application/use-cases/activate-tax-strategy.use-case';
import { CreateTaxStrategy } from '../src/modules/tax/application/use-cases/create-tax-strategy.use-case';
import { DeleteTaxStrategy } from '../src/modules/tax/application/use-cases/delete-tax-strategy.use-case';
import { ListTaxStrategies } from '../src/modules/tax/application/use-cases/list-tax-strategies.use-case';
import { UpdateTaxStrategy } from '../src/modules/tax/application/use-cases/update-tax-strategy.use-case';
import { TAX_STATUS } from '../src/modules/tax/presentation/http-answers';
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

// The tax strategy routes (admin) over HTTP: the real guards and controllers; the use cases are
// stubs, so this proves the session, the panel population, CSRF, the closed bodies, the status of
// each refusal, the answer shape and `no-store`. The use cases have their own spec.

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

it('maps every refusal code of the tax routes to its exact status', () => {
  expect(TAX_STATUS).toEqual({
    'validation.failed': 400,
    'tax.strategy-not-found': 404,
    'tax.strategy-active': 409,
    'tax.unavailable': 503,
  });
});

describe.each(TEST_MARKETS)('tax strategies over HTTP in market %s', (code) => {
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
          .overrideProvider(ListTaxStrategies)
          .useValue(stub('list'))
          .overrideProvider(CreateTaxStrategy)
          .useValue(stub('create'))
          .overrideProvider(UpdateTaxStrategy)
          .useValue(stub('update'))
          .overrideProvider(DeleteTaxStrategy)
          .useValue(stub('delete'))
          .overrideProvider(ActivateTaxStrategy)
          .useValue(stub('activate')),
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
  const BASE = '/tax/admin/strategies';
  const STRATEGY_ID = id<'TaxStrategy'>(0xd001);
  const strategy = {
    id: STRATEGY_ID,
    name: 'GST',
    params: { kind: 'flat-rate', rateBps: 1000 },
    active: false,
    createdAt: START,
    updatedAt: START,
  };
  const strategyJson = {
    id: STRATEGY_ID,
    name: 'GST',
    kind: 'flat-rate',
    rateBps: 1000,
    defaultRateBps: null,
    categoryRatesBps: null,
    active: false,
    createdAt: START.toString(),
    updatedAt: START.toString(),
  };
  const listing = {
    builtInRateBps: 1000,
    activeStrategyId: null,
    categoryCodes: ['taxable'],
    strategies: [strategy],
  };
  const body = { name: 'GST', kind: 'flat-rate', rateBps: 1000 };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(strategy);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin list, define, change, activate and remove strategies', async () => {
    await boot();
    const session = admin();

    next = ok(listing);
    const read = await call('get', 'admin', BASE, session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({ ...listing, strategies: [strategyJson] });

    next = ok(strategy);
    const made = await call('post', 'admin', BASE, session, body);
    expect(made.status).toBe(201);
    expect(made.body).toEqual(strategyJson);
    const changed = await call('put', 'admin', `${BASE}/${STRATEGY_ID}`, session, body);
    expect(changed.status).toBe(200);

    next = ok(listing);
    const switched = await call('post', 'admin', `${BASE}/active`, session, {
      strategyId: STRATEGY_ID,
    });
    expect(switched.status).toBe(200);
    const builtIn = await call('post', 'admin', `${BASE}/active`, session, { strategyId: null });
    expect(builtIn.status).toBe(200);

    next = ok({ deleted: true });
    const removed = await call('delete', 'admin', `${BASE}/${STRATEGY_ID}`, session);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true });
    expect(calls).toEqual([
      { name: 'list', input: {} },
      { name: 'create', input: body },
      { name: 'update', input: { strategyId: STRATEGY_ID, body } },
      { name: 'activate', input: { strategyId: STRATEGY_ID } },
      { name: 'activate', input: { strategyId: null } },
      { name: 'delete', input: { strategyId: STRATEGY_ID } },
    ]);
  });

  it('refuses a write without CSRF, with a stray field and not as JSON', async () => {
    await boot();
    const session = admin();

    expect((await call('post', 'admin', BASE, { cookie: session.cookie }, body)).status).toBe(403);
    expect(
      (await call('delete', 'admin', `${BASE}/${STRATEGY_ID}`, { cookie: session.cookie })).status,
    ).toBe(403);
    const extra = await call('post', 'admin', BASE, session, { ...body, active: true });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'active', code: 'unknown-field' }] },
    });
    const text = await http()
      .post(BASE)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('maps invalid, unknown, active, unavailable and denied', async () => {
    await boot();
    const session = admin();
    const post = () => call('post', 'admin', BASE, session, body);

    next = err({ code: 'validation.failed', fields: [{ path: 'rateBps', code: 'range' }] });
    const invalid = await post();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'rateBps', code: 'range' }] },
    });
    next = err({ code: 'tax.strategy-not-found' });
    expect((await call('put', 'admin', `${BASE}/${STRATEGY_ID}`, session, body)).status).toBe(404);
    next = err({ code: 'tax.strategy-active' });
    expect((await call('delete', 'admin', `${BASE}/${STRATEGY_ID}`, session)).status).toBe(409);
    next = err({ code: 'tax.unavailable' });
    expect((await post()).status).toBe(503);
    next = err({ code: 'access.denied' });
    expect((await post()).status).toBe(403);
  });
});
