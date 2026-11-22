import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { ViewAdminWorkQueue } from '../src/modules/dashboard/application/use-cases/view-admin-work-queue.use-case';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The dashboard's work-queue route over HTTP (dashboards upgrade, phase 1): the real guards and
// controller, a stub use case. It proves the admin population, the body shape (an error queue has
// no count), `no-store` and the status of each refusal.

const START = Temporal.Instant.from('2026-11-22T01:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const CUSTOMER = id<'Account'>(0xa101);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('the admin work queue over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: unknown[];
  let actors: unknown[];
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
          .overrideProvider(ViewAdminWorkQueue)
          .useValue({
            execute: (context: { actor: unknown }, input: unknown) => {
              calls.push(input);
              actors.push(context.actor);
              return Promise.resolve(next);
            },
          }),
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

  function sessionOf(population: 'customer' | 'admin') {
    const issued = tokens.issue();
    const n = population === 'customer' ? 1 : 2;
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
    return { cookie: `__Host-session-${population}-${code}=${issued.token}` };
  }

  const get = (headers: Record<string, string>, admin = true) =>
    http()
      .get('/dashboard/admin/work-queue')
      .set({ 'x-market-id': code, ...(admin ? panelHeaders(code, 'admin') : {}), ...headers });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    actors = [];
  });
  afterEach(async () => {
    await app?.close();
  });

  it('answers the queues, an error queue without a count, no-store', async () => {
    await boot();
    next = ok({
      panel: 'admin',
      generatedAt: START,
      queues: [
        {
          key: 'security.open-alerts',
          level: 'critical',
          status: 'ok',
          count: 3,
          overdue: 1,
          oldestAt: START.subtract({ hours: 2 }),
          countedAt: START,
        },
        { key: 'ordering.refunds-pending', level: 'today', status: 'error' },
        {
          key: 'catalog.offers-awaiting-review',
          level: 'today',
          status: 'ok',
          count: 0,
          overdue: 0,
          oldestAt: null,
          countedAt: START.subtract({ seconds: 30 }),
        },
      ],
    });
    const answer = await get(sessionOf('admin'));
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toEqual({
      panel: 'admin',
      generatedAt: START.toString(),
      queues: [
        {
          key: 'security.open-alerts',
          level: 'critical',
          status: 'ok',
          count: 3,
          overdue: 1,
          oldestAt: START.subtract({ hours: 2 }).toString(),
          countedAt: START.toString(),
        },
        { key: 'ordering.refunds-pending', level: 'today', status: 'error' },
        {
          key: 'catalog.offers-awaiting-review',
          level: 'today',
          status: 'ok',
          count: 0,
          overdue: 0,
          oldestAt: null,
          countedAt: START.subtract({ seconds: 30 }).toString(),
        },
      ],
    });
    expect(calls).toEqual([{}]);
  });

  it.each([
    ['access.unauthenticated', 401],
    ['access.denied', 403],
    ['access.unavailable', 503],
  ])('answers %s with %i', async (refusal, status) => {
    await boot();
    next = err({ code: refusal });
    const answer = await get(sessionOf('admin'));
    expect(answer.status).toBe(status);
    expect(answer.body).toEqual({ statusCode: status, code: refusal });
  });

  it("reads the admin's own session; a customer cookie is no admin session", async () => {
    await boot();
    next = ok({ panel: 'admin', generatedAt: START, queues: [] });
    expect((await get(sessionOf('admin'))).status).toBe(200);
    expect(actors[0]).toMatchObject({
      kind: 'authenticated',
      population: 'admin',
      accountId: ADMIN,
    });
    // The use case refuses the anonymous actor (stubbed here as its refusal).
    next = err({ code: 'access.unauthenticated' });
    expect((await get(sessionOf('customer'), false)).status).toBe(401);
    expect(actors[1]).toMatchObject({ kind: 'anonymous' });
  });
});
