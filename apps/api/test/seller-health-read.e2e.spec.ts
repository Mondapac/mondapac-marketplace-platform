import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { SELLER_FILE_REPOSITORY } from '../src/modules/sellers/application/ports/seller-file.repository';
import { SELLER_LIST_REPOSITORY } from '../src/modules/sellers/application/ports/seller-list.repository';
import {
  SELLER_HEALTH_STORE,
  type SellerHealthSnapshot,
} from '../src/modules/sellers/application/ports/seller-health.store';
import {
  computeSellerHealth,
  type SellerHealthInput,
} from '../src/modules/sellers/domain/seller-health';
import { DefaultSellerHealthPolicy } from '../src/modules/sellers/infrastructure/default-seller-health-policy';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin seller health routes over HTTP (seller health packages 5a and 5c):
// `GET /sellers/admin/:sellerId/health` and `GET /sellers/admin/health-queue` with the real
// guards, controllers, gates and use cases on both Market fixtures. Identity's database ports
// are in-memory fakes; the seller file, list and health stores are stubs (their SQL is covered
// by the db-specs). Admin sessions are seeded into the fake store as in the admin team list spec.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xb000 + n)}`);
const SELLER = id<'Seller'>(`01990000-0000-7000-8000-${n12(0xc001)}`);
const UNKNOWN = id<'Seller'>(`01990000-0000-7000-8000-${n12(0xc002)}`);
const ROOT = accountId(1);
const NO_KEY = accountId(2);
const CUSTOMER = accountId(3);

const INPUT: SellerHealthInput = {
  orders: 40,
  sellerCancellations: { count: 0, base: 0 },
  lateReady: { count: 2, base: 40 },
  lostDisputes: { count: 0, base: 40 },
  customerRating: { count: 8, averageHundredths: 460 },
  reports: null,
};

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

// The admin health card over HTTP (seller health package 5a): `GET /sellers/admin/:sellerId/health`
// with the real guards, controller, gate and use case on both Market fixtures. The seller file and
// the health store are recording stubs (their SQL is covered by the db-specs).
describe('admin seller health card over HTTP (integration, seller health 5a)', () => {
  let app: NestExpressApplication;
  let snapshots: SellerHealthSnapshot[];
  let known: Set<string>;
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(SELLER_FILE_REPOSITORY)
          .useValue({
            findById: (m: MarketContext, one: Id<'Seller'>) =>
              Promise.resolve(known.has(`${m.marketId}|${one}`) ? {} : null),
          })
          .overrideProvider(SELLER_HEALTH_STORE)
          .useValue({
            snapshots: (m: MarketContext, one: Id<'Seller'>) =>
              Promise.resolve(known.has(`${m.marketId}|${one}`) ? snapshots : []),
            // The queue of a Market is the sellers `known` in it.
            unhealthy: (m: MarketContext) =>
              Promise.resolve({
                sellers: [...known]
                  .filter((key) => key.startsWith(`${m.marketId}|`))
                  .map((key) => ({
                    sellerId: key.split('|')[1] as Id<'Seller'>,
                    day: Temporal.PlainDate.from('2026-11-10'),
                    kind: 'scored' as const,
                    band: 'unhealthy' as const,
                    score: 12,
                    lowestMetric: 'late-ready' as const,
                  })),
                truncated: false,
              }),
          })
          .overrideProvider(SELLER_LIST_REPOSITORY)
          .useValue({
            all: (m: MarketContext, query: { onlyIds: readonly Id<'Seller'>[] | null }) =>
              Promise.resolve(
                (query.onlyIds ?? []).map((one) => ({
                  sellerId: one,
                  storeName: `Shop of ${m.marketId}`,
                  heldSlug: null,
                  draftSlug: 'shop',
                })),
              ),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const roleOf = (code: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
    )!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'health-0001'), {});
    const marketId = code as AccountState['marketId'];
    const account = (n: number, idOf: Id<'Account'>, population: AccountState['population']) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `Person${n}@Example.com`, normalized: `person${n}@example.com` },
        displayName: population === 'customer' ? null : `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    const assign = (n: number, idOf: Id<'Account'>, roleId: Id<'Role'>) =>
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe200 + n)}`),
        marketId,
        accountId: idOf,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    account(1, ROOT, 'admin');
    assign(1, ROOT, roleOf(code, 'platform-administrator'));
    // An admin whose role lacks `sellers.seller.view`.
    const noKeyRole = id<'Role'>(`01990000-0000-7000-8000-${n12(0xe100)}`);
    fakes.seedRole({
      id: noKeyRole,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      permissionKeys: ['identity.customer-account.view'],
      version: 1,
      createdAt: START,
    });
    account(2, NO_KEY, 'admin');
    assign(2, NO_KEY, noKeyRole);
    account(3, CUSTOMER, 'customer');
    known.add(`${code}|${SELLER}`);
  }

  function sessionHeaders(
    code: string,
    account: Id<'Account'>,
    n: number,
    population: 'admin' | 'customer' = 'admin',
  ) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf200 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return { cookie: `__Host-session-${population}-${code}=${issued.token}` };
  }

  const get = (code: string, headers: { cookie: string } | null, seller: string = SELLER) => {
    const call = http()
      .get(`/sellers/admin/${seller}/health`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    return headers === null ? call : call.set('cookie', headers.cookie);
  };

  const getQueue = (code: string, headers: { cookie: string } | null) => {
    const call = http()
      .get('/sellers/admin/health-queue')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    return headers === null ? call : call.set('cookie', headers.cookie);
  };

  beforeEach(async () => {
    fakes.reset();
    clock = new FixedClock(Temporal.Instant.from('2026-11-10T12:00:00Z'));
    known = new Set();
    const { thresholds } = await new DefaultSellerHealthPolicy().settings();
    snapshots = [
      {
        day: Temporal.PlainDate.from('2026-11-10'),
        health: computeSellerHealth(INPUT, thresholds),
        inputs: INPUT,
        computedAt: clock.now(),
      },
    ];
  });
  afterEach(async () => {
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('returns the card and the trend to an administrator, no-store', async () => {
      await boot();
      await seeded(code);

      const res = await get(code, sessionHeaders(code, ROOT, 1));

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as {
        sellerId: string;
        current: { kind: string; orders: number; metrics: unknown[] };
        trend: { day: string }[];
      };
      expect(body.sellerId).toBe(SELLER);
      expect(body.current).toMatchObject({ kind: 'scored', orders: 40 });
      expect(body.current.metrics).toHaveLength(5);
      expect(body.trend.map((p) => p.day)).toEqual(['2026-11-10']);
    });

    it('answers 404 for an unknown seller and for a seller of another Market', async () => {
      await boot();
      await seeded(code);
      const other = TEST_MARKETS.find((m) => m !== code)!;
      known.add(`${other}|${UNKNOWN}`);

      const unknown = await get(code, sessionHeaders(code, ROOT, 2), UNKNOWN);
      const foreign = await get(code, sessionHeaders(code, ROOT, 3), 'not-an-id');

      expect(unknown.status).toBe(404);
      expect(foreign.status).toBe(404);
      expect(unknown.body).toEqual(foreign.body);
    });

    it('refuses an admin without the permission, a customer session and no session', async () => {
      await boot();
      await seeded(code);

      const noKey = await get(code, sessionHeaders(code, NO_KEY, 4));
      const customer = await get(code, sessionHeaders(code, CUSTOMER, 5, 'customer'));
      const anonymous = await get(code, null);

      expect(noKey.status).toBe(403);
      expect(noKey.body).toMatchObject({ code: 'access.denied' });
      expect(noKey.headers['cache-control']).toBe('no-store');
      expect([401, 403]).toContain(customer.status);
      expect(anonymous.status).toBe(401);
    });

    it('lists the queue for an administrator, no-store, and refuses the others', async () => {
      await boot();
      await seeded(code);
      const other = TEST_MARKETS.find((m) => m !== code)!;
      known.add(`${other}|${UNKNOWN}`);

      const res = await getQueue(code, sessionHeaders(code, ROOT, 6));
      const noKey = await getQueue(code, sessionHeaders(code, NO_KEY, 7));
      const anonymous = await getQueue(code, null);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        truncated: false,
        items: [
          {
            sellerId: SELLER,
            storeName: `Shop of ${code}`,
            slug: 'shop',
            day: '2026-11-10',
            score: 12,
            lowestMetric: 'late-ready',
          },
        ],
      });
      expect(noKey.status).toBe(403);
      expect(noKey.body).toMatchObject({ code: 'access.denied' });
      expect(anonymous.status).toBe(401);
    });
  });
});
