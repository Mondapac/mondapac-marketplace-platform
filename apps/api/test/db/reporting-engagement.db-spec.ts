import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { EngagementDependencies } from '../../src/modules/engagement/application/engagement-dependencies';
import {
  FakePublishedStores,
  RecordingEngagementOutbox,
} from '../../src/modules/engagement/application/testing/in-memory-engagement';
import { CountShoppingFunnel } from '../../src/modules/engagement/application/use-cases/count-shopping-funnel.use-case';
import { ForgetAccount } from '../../src/modules/engagement/application/use-cases/forget-account.use-case';
import { RecordEvent } from '../../src/modules/engagement/application/use-cases/record-event.use-case';
import { RecordGuestEvent } from '../../src/modules/engagement/application/use-cases/record-guest-event.use-case';
import { SetPersonalization } from '../../src/modules/engagement/application/use-cases/set-personalization.use-case';
import { CryptoEngagementGuestTokens } from '../../src/modules/engagement/infrastructure/crypto-guest-tokens';
import { PrismaBehaviourEventRepository } from '../../src/modules/engagement/infrastructure/prisma-behaviour-event.repository';
import { PrismaPersonalizationSettingRepository } from '../../src/modules/engagement/infrastructure/prisma-personalization-setting.repository';
import { PrismaStoreFollowRepository } from '../../src/modules/engagement/infrastructure/prisma-store-follow.repository';
import type { ReportCheckout } from '../../src/modules/ordering';
import { SnapshotDailyEngagement } from '../../src/modules/reporting/application/use-cases/snapshot-daily-engagement.use-case';
import { ViewMarketplaceShoppingFunnel } from '../../src/modules/reporting/application/use-cases/view-marketplace-shopping-funnel.use-case';
import type { MarketDay } from '../../src/modules/reporting/domain/facts';
import { FacadeEngagementSources } from '../../src/modules/reporting/infrastructure/facade-engagement-sources';
import { PrismaEngagementStore } from '../../src/modules/reporting/infrastructure/prisma-engagement-store';
import { RegistryMarketZone } from '../../src/modules/reporting/infrastructure/registry-market-zone';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The shopping funnel on PostgreSQL (dashboards v2, phase 2), both Market fixtures: engagement's
// real behaviour store counts the Market day (signed-in customers with personalization on, never a
// guest), reporting's snapshot writes the day once as the application role, and a customer's later
// opt-out or erasure deletes their behaviour but leaves the day's counts as they were (Hassan).
// The application role may only SELECT and INSERT the table; the CHECK keeps the steps nested.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK = '23514';
// A day no other db-spec records behaviour on.
const DAY = '2026-05-10' as MarketDay;

describe.each(TEST_MARKETS)('the shopping funnel in market %s (database)', (code) => {
  const market = marketOf(code);
  const zone = new RegistryMarketZone(markets);
  const tz = zone.zoneOf(market);
  const dayStart = Temporal.PlainDate.from(DAY).toZonedDateTime({ timeZone: tz });
  const noon = dayStart.add({ hours: 12 }).toInstant();
  const clock = new FixedClock(noon);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system');
  let db: Persistence;
  let engagement: EngagementDependencies;
  let store: PrismaEngagementStore;
  let app: Client;
  let owner: Client;
  let checkouts: ReportCheckout[];

  beforeAll(async () => {
    db = createPersistence();
    engagement = {
      unitOfWork: db.unitOfWork,
      events: new PrismaBehaviourEventRepository(db.service),
      settings: new PrismaPersonalizationSettingRepository(db.service),
      guestTokens: new CryptoEngagementGuestTokens(),
      follows: new PrismaStoreFollowRepository(db.service),
      stores: new FakePublishedStores(),
      outbox: new RecordingEngagementOutbox(),
      ids,
      clock,
    };
    store = new PrismaEngagementStore(db.service);
    app = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await app.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await db.close();
    await app.end();
    await owner.end();
  });

  const customer = (accountId: Id<'Account'>): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'funnel-db-abcd',
    );
  const record = async (accountId: Id<'Account'>, event: Record<string, unknown>) => {
    const out = await new RecordEvent(gate, engagement).execute(customer(accountId), {
      event,
      globalPrivacyControl: false,
    });
    expect(out).toEqual({ ok: true, value: { recorded: true } });
  };
  const sources = () =>
    new FacadeEngagementSources(
      { checkoutsStarted: () => Promise.resolve(ok({ items: checkouts, complete: true })) },
      {
        shoppingFunnel: (context, request) =>
          new CountShoppingFunnel(gate, engagement).execute(context, request),
      },
    );
  const snapshot = () =>
    new SnapshotDailyEngagement(gate, {
      unitOfWork: db.unitOfWork,
      store,
      sources: sources(),
      zone,
      clock,
    });
  const rowOf = async () =>
    (
      await owner.query<Record<string, unknown>>(
        `SELECT viewed_count, carted_count, checkout_count, paid_count
           FROM reporting.daily_engagement WHERE market_id = $1 AND market_day = $2`,
        [market.marketId, DAY],
      )
    ).rows;

  it('writes the Market day once and keeps it through an opt-out and an erasure', async () => {
    const a = ids.next<'Account'>();
    const b = ids.next<'Account'>();
    const c = ids.next<'Account'>();
    const d = ids.next<'Account'>();
    const product = ids.next<'Product'>();
    const offer = ids.next<'Offer'>();
    const viewed = { kind: 'product-viewed', productId: product, offerId: offer };
    const carted = { kind: 'added-to-cart', offerId: offer, variantId: ids.next<'Variant'>() };
    for (const account of [a, b, c, d]) await record(account, viewed);
    for (const account of [a, b, c]) await record(account, carted);
    // A guest's view of the day never counts.
    const guest = await new RecordGuestEvent(gate, engagement).execute(
      testCallContext(market, 'anonymous'),
      { event: viewed, consent: true, token: null, globalPrivacyControl: false },
    );
    expect(guest).toMatchObject({ ok: true, value: { recorded: true } });
    checkouts = [
      { accountId: a, paid: true },
      { accountId: b, paid: false },
    ];

    // Two hours after the Market day ends, in the Market's zone.
    clock.set(dayStart.add({ days: 1, hours: 2 }).toInstant());
    const first = await snapshot().execute(system, {});
    expect(first.ok && first.value.failedDays).toBe(0);
    expect(await rowOf()).toEqual([
      { viewed_count: 4, carted_count: 3, checkout_count: 2, paid_count: 1 },
    ]);

    // Customer a switches personalization off and b's account is erased: their behaviour goes.
    const off = await new SetPersonalization(gate, engagement).execute(customer(a), {
      enabled: false,
    });
    expect(off.ok).toBe(true);
    const forgot = await new ForgetAccount(gate, engagement).execute(system, { accountId: b });
    expect(forgot.ok).toBe(true);
    const window = {
      from: dayStart.toInstant(),
      to: dayStart.add({ days: 1 }).toInstant(),
    };
    const now = await new CountShoppingFunnel(gate, engagement).execute(system, {
      window,
      checkouts,
    });
    expect(now).toEqual({ ok: true, value: { viewed: 2, carted: 1, checkedOut: 0, paid: 0 } });

    // The day's row is as it was, a later run does not rewrite it, and the read still sums it.
    const again = await snapshot().execute(system, {});
    expect(again.ok && again.value.written).toBe(0);
    expect(await rowOf()).toEqual([
      { viewed_count: 4, carted_count: 3, checkout_count: 2, paid_count: 1 },
    ]);
    const days = await db.unitOfWork.run(
      market,
      async () => ok(await store.days(market, { from: DAY, to: DAY })),
      { readOnly: true },
    );
    expect(days.ok && days.value).toEqual([
      { day: DAY, viewed: 4, carted: 3, checkedOut: 2, paid: 1 },
    ]);
    const read = new ViewMarketplaceShoppingFunnel(gate, {
      unitOfWork: db.unitOfWork,
      store,
      zone,
      clock,
    });
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    const answer = await read.execute(admin, { period: { from: DAY, to: DAY } });
    expect(answer.ok && answer.value.funnel).toEqual({
      status: 'not-enough-data',
      minimum: 20,
      recordedDays: 1,
      periodDays: 1,
    });
  });

  it('lets the application role only read and insert, and keeps the steps nested', async () => {
    const insert = (marketDay: string, counts: readonly number[]) =>
      `INSERT INTO reporting.daily_engagement
         (market_id, tenant_id, market_day, viewed_count, carted_count, checkout_count, paid_count, recorded_at)
       VALUES ('${market.marketId}', '${market.tenantId}', '${marketDay}', ${counts.join(', ')}, now())`;
    await expect(
      app.query(`UPDATE reporting.daily_engagement SET viewed_count = 0 WHERE market_id = $1`, [
        market.marketId,
      ]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(`DELETE FROM reporting.daily_engagement WHERE market_id = $1`, [market.marketId]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    for (const counts of [
      [1, 2, 0, 0],
      [5, 3, 4, 0],
      [5, 3, 2, 3],
      [5, 3, 2, -1],
    ]) {
      await expect(owner.query(insert('2026-06-01', counts))).rejects.toMatchObject({
        code: CHECK,
      });
    }
    // The same day twice keeps the first row.
    const day = '2026-06-02' as MarketDay;
    const twice = await db.unitOfWork.run(market, async () =>
      ok([
        await store.insertDay(
          market,
          { day, viewed: 3, carted: 2, checkedOut: 1, paid: 1 },
          clock.now(),
        ),
        await store.insertDay(
          market,
          { day, viewed: 9, carted: 9, checkedOut: 9, paid: 9 },
          clock.now(),
        ),
      ]),
    );
    expect(twice.ok && twice.value).toEqual([true, false]);
    const kept = await owner.query<{ viewed_count: number }>(
      `SELECT viewed_count FROM reporting.daily_engagement WHERE market_id = $1 AND market_day = $2`,
      [market.marketId, day],
    );
    expect(kept.rows).toEqual([{ viewed_count: 3 }]);
  });
});
