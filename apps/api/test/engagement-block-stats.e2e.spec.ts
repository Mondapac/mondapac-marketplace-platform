import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ViewBlockStats } from '../src/modules/engagement/application/use-cases/view-block-stats.use-case';
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

// The admin read of block counts over HTTP (personalization 1d-3, part C): the real guards and
// controller with the use case stubbed, so this proves the admin session, the panel population,
// the query handed over as sent, the answer shape with days as YYYY-MM-DD, `no-store`, and the
// status of each refusal. The use case and its permission have their own spec.

const START = Temporal.Instant.from('2026-10-25T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const PAGE = id<'StorefrontPage'>(0xd001);
const HERO = id<'StorefrontPlacement'>(0xb001);
const PATH = '/engagement/admin/block-stats';
const day = (value: string) => Temporal.PlainDate.from(value);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('block stats route in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let next: unknown;
  let calls: unknown[];
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const clock = new FixedClock(START);

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(ViewBlockStats)
          .useValue({
            execute: (_c: unknown, input: unknown) => {
              calls.push(input);
              return Promise.resolve(next);
            },
          }),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'bs-seed-0001'), {});
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
      marketOf(),
      openSession({
        id: id<'Session'>(0xf101),
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
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const get = (query: string, headers: Record<string, string>) =>
    request(app!.getHttpServer())
      .get(`${PATH}${query}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers });

  beforeEach(() => {
    fakes.reset();
    calls = [];
    next = ok({
      pageId: PAGE,
      from: day('2026-10-01'),
      to: day('2026-10-02'),
      truncated: false,
      blocks: [
        {
          placementId: HERO,
          impressions: 8,
          clicks: 1,
          days: [
            { day: day('2026-10-01'), impressions: 3, clicks: 0 },
            { day: day('2026-10-02'), impressions: 5, clicks: 1 },
          ],
        },
      ],
    });
  });
  afterEach(async () => {
    await app?.close();
  });

  it('answers an admin with the counts per block and day, no-store', async () => {
    await boot();
    const answer = await get(`?page=${PAGE}&from=2026-10-01&to=2026-10-02`, adminSession());
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual([{ query: { page: PAGE, from: '2026-10-01', to: '2026-10-02' } }]);
    expect(answer.body).toEqual({
      pageId: PAGE,
      from: '2026-10-01',
      to: '2026-10-02',
      truncated: false,
      blocks: [
        {
          placementId: HERO,
          impressions: 8,
          clicks: 1,
          days: [
            { day: '2026-10-01', impressions: 3, clicks: 0 },
            { day: '2026-10-02', impressions: 5, clicks: 1 },
          ],
        },
      ],
    });
  });

  it.each([
    [err({ code: 'access.denied' }), 403, { statusCode: 403, code: 'access.denied' }],
    [
      err({ code: 'access.unauthenticated' }),
      401,
      { statusCode: 401, code: 'access.unauthenticated' },
    ],
    [
      err({ code: 'validation.failed', fields: [{ path: 'to', code: 'span-too-long' }] }),
      400,
      {
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'to', code: 'span-too-long' }] },
      },
    ],
  ])('answers a refusal with its status, no-store (%#)', async (refusal, status, body) => {
    await boot();
    next = refusal;
    const answer = await get(`?page=${PAGE}&from=2026-01-01&to=2026-12-31`, adminSession());
    expect(answer.status).toBe(status);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toEqual(body);
  });
});
