import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { ViewAdminKpis } from '../src/modules/dashboard/application/use-cases/view-admin-kpis.use-case';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin KPI route over HTTP (dashboards upgrade, phase 5): the real guards and controller, a
// stub use case. It proves the period query (default 7d, a bad or extra key is validation.failed),
// the body (money as strings, a section the viewer has no key for is null, an error section has
// no numbers), `no-store` and the status of each refusal.

const START = Temporal.Instant.from('2026-11-22T01:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('the admin KPIs over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: unknown[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(ViewAdminKpis)
          .useValue({
            execute: (_context: unknown, input: unknown) => {
              calls.push(input);
              return Promise.resolve(next);
            },
          }),
    }));
    fakes.seedAccount({
      id: ADMIN,
      marketId,
      population: 'admin',
      email: { typed: 'admin@Example.com', normalized: 'admin@example.com' },
      displayName: 'admin',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
  }

  function adminSession() {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      testMarketContext(code, PLATFORM_TENANT_ID),
      openSession({
        id: id<'Session'>(0xf102),
        marketId,
        accountId: ADMIN,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return { cookie: `__Host-session-admin-${code}=${issued.token}` };
  }

  const get = (query: string) =>
    http()
      .get(`/dashboard/admin/kpis${query}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...adminSession() });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
  });
  afterEach(async () => {
    await app?.close();
  });

  it('answers the sections as strings and nulls, no-store, asking 7d by default', async () => {
    await boot();
    const period = {
      id: '30d',
      current: { from: '2026-10-24', to: '2026-11-22' },
      previous: { from: '2026-09-24', to: '2026-10-23' },
      days: 30,
    };
    const zero = { value: 0, direction: 'flat', state: 'na' };
    next = ok({
      generatedAt: START,
      period: '30d',
      operations: null,
      topSellers: null,
      topCategories: null,
      health: null,
      ordersByState: null,
      marketTarget: null,
      reviews: null,
      shoppingFunnel: null,
      ordersByStatus: {
        status: 'ok',
        value: {
          period,
          timezone: 'Australia/Brisbane',
          window: {
            from: Temporal.Instant.from('2026-10-23T14:00:00Z'),
            to: Temporal.Instant.from('2026-11-22T14:00:00Z'),
          },
          generatedAt: START,
          counts: {
            paid: 10,
            toShip: 1,
            shipped: 2,
            delivered: 5,
            cancelled: 1,
            refunded: 1,
            cancelledRateBp: 1000,
            refundedRateBp: 1000,
          },
          sameDayShare: { status: 'available', sameDay: 3, paid: 10, rateBp: 3000 },
        },
      },
      finance: {
        status: 'ok',
        value: {
          period,
          currency: 'AUD',
          generatedAt: START,
          refreshedAt: START.subtract({ minutes: 4 }),
          current: {
            gmvWithTax: 123_456n,
            gmvWithoutTax: 112_233n,
            refundedWithTax: 0n,
            refundRateBp: null,
            netSalesWithTax: 123_456n,
            averageOrderWithTax: 41_152n,
          },
          previous: {
            gmvWithTax: 0n,
            gmvWithoutTax: 0n,
            refundedWithTax: 0n,
            refundRateBp: null,
            netSalesWithTax: 0n,
            averageOrderWithTax: null,
          },
          deltas: { gmvWithTax: zero },
          series: [{ day: '2026-11-22', gmvWithTax: 5n, gmvWithoutTax: 4n, refundedWithTax: 1n }],
          previousSeries: [],
          net: null,
        },
      },
    });
    const answer = await get('?period=30d');
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toMatchObject({
      generatedAt: START.toString(),
      periodId: '30d',
      period: { id: '30d', current: { from: '2026-10-24', to: '2026-11-22' } },
      operations: null,
      topSellers: null,
      topCategories: null,
      health: null,
      marketTarget: null,
      reviews: null,
      finance: {
        status: 'ok',
        refreshedAt: START.subtract({ minutes: 4 }).toString(),
        kpis: {
          currency: 'AUD',
          current: {
            gmvWithTax: { amountMinor: '123456', currency: 'AUD' },
            averageOrderWithTax: { amountMinor: '41152', currency: 'AUD' },
          },
          previous: { averageOrderWithTax: null },
          series: [{ day: '2026-11-22', gmvWithTax: '5' }],
          net: null,
        },
      },
      ordersByStatus: {
        status: 'ok',
        kpis: {
          paid: 10,
          toShip: 1,
          delivered: 5,
          refundedRateBp: 1000,
          sameDayShare: { status: 'available', sameDay: 3, paid: 10, rateBp: 3000 },
        },
      },
    });
    expect(calls).toEqual([{ period: '30d' }]);
    await get('');
    expect(calls[1]).toEqual({ period: '7d' });
  });

  it('answers an error section without numbers', async () => {
    await boot();
    next = ok({
      generatedAt: START,
      period: '7d',
      operations: { status: 'error' },
      ordersByState: { status: 'error' },
      marketTarget: { status: 'error' },
      reviews: { status: 'error' },
      shoppingFunnel: { status: 'error' },
      ordersByStatus: { status: 'error' },
      topSellers: null,
      topCategories: null,
      health: null,
      finance: null,
    });
    const answer = await get('?period=7d');
    expect(answer.body).toMatchObject({
      period: null,
      operations: { status: 'error' },
      ordersByStatus: { status: 'error' },
      marketTarget: { status: 'error' },
      reviews: { status: 'error' },
      shoppingFunnel: { status: 'error' },
      finance: null,
    });
    expect((answer.body as { operations: unknown }).operations).toEqual({ status: 'error' });
  });

  it.each([
    ['?period=year', [{ path: 'period', code: 'enum' }]],
    ['?period=7d&limit=5', [{ path: 'limit', code: 'unknown-field' }]],
  ])('refuses %s as validation.failed before the use case', async (query, fields) => {
    await boot();
    next = ok({});
    const answer = await get(query);
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields },
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ['access.unauthenticated', 401],
    ['access.denied', 403],
    ['access.unavailable', 503],
  ])('answers %s with %i', async (refusal, status) => {
    await boot();
    next = err({ code: refusal });
    const answer = await get('');
    expect(answer.status).toBe(status);
    expect(answer.body).toEqual({ statusCode: status, code: refusal });
  });
});
