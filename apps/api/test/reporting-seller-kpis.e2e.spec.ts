import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { ViewSellerKpis } from '../src/modules/reporting/application/use-cases/view-seller-kpis.use-case';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller KPI route over HTTP (dashboards upgrade, phase 6, PR 16): the real guards and
// controller, a stub use case. It proves the seller population (the use case receives the
// session's seller and no id from the query), the body shape (money as strings), `no-store`, the
// period passed through and the status of each refusal.

const START = Temporal.Instant.from('2026-11-22T01:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa201);
const ADMIN = id<'Account'>(0xa001);
const SELLER = id<'Seller'>(0x5e11);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('the seller KPIs over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let next: unknown;
  let actors: unknown[];
  let inputs: unknown[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(ViewSellerKpis)
          .useValue({
            execute: (context: { actor: unknown }, input: unknown) => {
              actors.push(context.actor);
              inputs.push(input);
              return Promise.resolve(next);
            },
          }),
    }));
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
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xeb01),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
  }

  function sessionOf(population: 'seller' | 'admin') {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      testMarketContext(code, PLATFORM_TENANT_ID),
      openSession({
        id: id<'Session'>(population === 'seller' ? 0xf201 : 0xf202),
        marketId,
        accountId: population === 'seller' ? OWNER : ADMIN,
        population,
        sellerId: population === 'seller' ? SELLER : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
      }),
      issued.tokenHash,
    );
    return { cookie: `__Host-session-${population}-${code}=${issued.token}` };
  }

  const get = (headers: Record<string, string>, seller = true) =>
    http()
      .get('/reporting/seller/kpis')
      .set({ 'x-market-id': code, ...(seller ? panelHeaders(code, 'seller') : {}), ...headers });

  beforeEach(() => {
    fakes.reset();
    actors = [];
    inputs = [];
  });
  afterEach(async () => {
    await app?.close();
  });

  const totals = (sales: bigint) => ({
    salesInclTax: sales,
    salesExclTax: sales - 100n,
    orders: 2,
    units: 3,
    averageOrderValue: sales / 2n,
    refundedInclTax: 0n,
    refunds: 0,
    refundRateBps: 0,
    ordersCancelled: 0,
    ordersShipped: 1,
    shippedOnTimeBps: 10000,
  });
  const answer = () =>
    ok({
      period: {
        id: '7d',
        current: { from: '2026-11-16', to: '2026-11-22' },
        previous: { from: '2026-11-09', to: '2026-11-15' },
        days: 7,
      },
      timezone: 'Australia/Brisbane',
      currency: 'AUD',
      kpis: {
        current: totals(2200n),
        previous: totals(1100n),
        series: [{ day: '2026-11-22', salesInclTax: 2200n, orders: 2, refundedInclTax: 0n }],
        previousSeries: [],
        topCategories: [
          {
            categoryId: id<'Category'>(0xca1),
            netSalesInclTax: 2200n,
            orders: 2,
            units: 3,
          },
        ],
        refreshedAt: START,
      },
    });

  it('answers the KPIs with money as strings, no-store, for the session seller and the period', async () => {
    await boot();
    next = answer();
    const reply = await get(sessionOf('seller')).query({ period: '7d', sellerId: 'other' });
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    const body = reply.body as {
      current: unknown;
      previous: { salesInclTax: string };
      series: unknown;
      topCategories: unknown[];
      refreshedAt: string;
      currency: string;
    };
    expect(body.current).toMatchObject({ salesInclTax: '2200', averageOrderValue: '1100' });
    expect(body.previous.salesInclTax).toBe('1100');
    expect(body.series).toEqual([
      { day: '2026-11-22', salesInclTax: '2200', orders: 2, refundedInclTax: '0' },
    ]);
    expect(body.topCategories[0]).toMatchObject({ netSalesInclTax: '2200' });
    expect(body.refreshedAt).toBe(START.toString());
    expect(body.currency).toBe('AUD');
    expect(inputs[0]).toEqual({ period: '7d' });
    expect(actors[0]).toMatchObject({
      kind: 'authenticated',
      population: 'seller',
      sellerId: SELLER,
    });
  });

  it.each([
    ['access.unauthenticated', 401],
    ['access.denied', 403],
    ['access.unavailable', 503],
    ['validation.failed', 400],
  ])('answers %s with %i', async (refusal, status) => {
    await boot();
    next = err({ code: refusal });
    const reply = await get(sessionOf('seller'));
    expect(reply.status).toBe(status);
    expect(reply.body).toEqual({ statusCode: status, code: refusal });
  });

  it('reads no seller session from an admin cookie', async () => {
    await boot();
    next = err({ code: 'access.unauthenticated' });
    expect((await get(sessionOf('admin'))).status).toBe(401);
    expect(actors[0]).toMatchObject({ kind: 'anonymous' });
  });
});
