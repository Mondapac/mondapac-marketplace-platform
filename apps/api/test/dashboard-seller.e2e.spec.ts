import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { ViewSellerTasks } from '../src/modules/dashboard/application/use-cases/view-seller-tasks.use-case';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller tasks route over HTTP (dashboards upgrade, phase 1, PR 6): the real guards and
// controller, a stub use case. It proves the seller population (the use case receives the
// session's seller), the body shape, `no-store` and the status of each refusal.

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

describe.each(TEST_MARKETS)('the seller tasks over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let next: unknown;
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
          .useValue(new FixedClock(START))
          .overrideProvider(ViewSellerTasks)
          .useValue({
            execute: (context: { actor: unknown }) => {
              actors.push(context.actor);
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
      .get('/dashboard/seller/tasks')
      .set({ 'x-market-id': code, ...(seller ? panelHeaders(code, 'seller') : {}), ...headers });

  beforeEach(() => {
    fakes.reset();
    actors = [];
  });
  afterEach(async () => {
    await app?.close();
  });

  it("answers the seller's queues, an error queue without a count, no-store", async () => {
    await boot();
    next = ok({
      panel: 'seller',
      generatedAt: START,
      queues: [
        {
          key: 'ordering.late-orders',
          level: 'critical',
          status: 'ok',
          count: 2,
          overdue: 1,
          oldestAt: START.subtract({ hours: 3 }),
          countedAt: START,
        },
        { key: 'reviews.unanswered', level: 'review', status: 'error' },
      ],
    });
    const answer = await get(sessionOf('seller'));
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toEqual({
      panel: 'seller',
      generatedAt: START.toString(),
      queues: [
        {
          key: 'ordering.late-orders',
          level: 'critical',
          status: 'ok',
          count: 2,
          overdue: 1,
          oldestAt: START.subtract({ hours: 3 }).toString(),
          countedAt: START.toString(),
        },
        { key: 'reviews.unanswered', level: 'review', status: 'error' },
      ],
    });
    expect(actors[0]).toMatchObject({
      kind: 'authenticated',
      population: 'seller',
      accountId: OWNER,
      sellerId: SELLER,
    });
  });

  it.each([
    ['access.unauthenticated', 401],
    ['access.denied', 403],
    ['access.unavailable', 503],
  ])('answers %s with %i', async (refusal, status) => {
    await boot();
    next = err({ code: refusal });
    const answer = await get(sessionOf('seller'));
    expect(answer.status).toBe(status);
    expect(answer.body).toEqual({ statusCode: status, code: refusal });
  });

  it('reads no seller session from an admin cookie', async () => {
    await boot();
    next = err({ code: 'access.unauthenticated' });
    expect((await get(sessionOf('admin'))).status).toBe(401);
    expect(actors[0]).toMatchObject({ kind: 'anonymous' });
  });
});
