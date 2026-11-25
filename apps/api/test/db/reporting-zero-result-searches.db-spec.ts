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
import { CountSearchShoppers } from '../../src/modules/engagement/application/use-cases/count-search-shoppers.use-case';
import { RecordEvent } from '../../src/modules/engagement/application/use-cases/record-event.use-case';
import { RecordGuestEvent } from '../../src/modules/engagement/application/use-cases/record-guest-event.use-case';
import { SetPersonalization } from '../../src/modules/engagement/application/use-cases/set-personalization.use-case';
import { CryptoEngagementGuestTokens } from '../../src/modules/engagement/infrastructure/crypto-guest-tokens';
import { PrismaBehaviourEventRepository } from '../../src/modules/engagement/infrastructure/prisma-behaviour-event.repository';
import { PrismaPersonalizationSettingRepository } from '../../src/modules/engagement/infrastructure/prisma-personalization-setting.repository';
import { PrismaStoreFollowRepository } from '../../src/modules/engagement/infrastructure/prisma-store-follow.repository';
import { SnapshotDailySearches } from '../../src/modules/reporting/application/use-cases/snapshot-daily-searches.use-case';
import { ViewMarketplaceZeroResultSearches } from '../../src/modules/reporting/application/use-cases/view-marketplace-zero-result-searches.use-case';
import type { MarketDay } from '../../src/modules/reporting/domain/facts';
import { FacadeSearchSources } from '../../src/modules/reporting/infrastructure/facade-search-sources';
import { PrismaSearchStore } from '../../src/modules/reporting/infrastructure/prisma-search-store';
import { RegistryMarketZone } from '../../src/modules/reporting/infrastructure/registry-market-zone';
import { PurgeZeroResultQueries } from '../../src/modules/search/application/use-cases/purge-zero-result-queries.use-case';
import { ZeroResultTextsOf } from '../../src/modules/search/application/use-cases/zero-result-texts.use-case';
import { zeroResultBucketOf } from '../../src/modules/search/domain/zero-result';
import { PrismaZeroResultLog } from '../../src/modules/search/infrastructure/prisma-zero-result-log';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Zero-result searches on PostgreSQL (dashboards v2, phase 2), both Market fixtures: search's real
// note of a text that found nothing, engagement's real behaviour store counting distinct
// signed-in searchers in any case (never a guest), reporting's snapshot writing only texts that
// ten or more searched, once, kept through a later opt-out. The application role may only SELECT
// and INSERT the reporting tables and never UPDATE search's notes; the CHECKs hold the minimum.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK = '23514';
// A day no other db-spec records behaviour or notes on.
const DAY = '2026-05-17' as MarketDay;

describe.each(TEST_MARKETS)('zero-result searches in market %s (database)', (code) => {
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
  let log: PrismaZeroResultLog;
  let store: PrismaSearchStore;
  let app: Client;
  let owner: Client;

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
    log = new PrismaZeroResultLog(db.service);
    store = new PrismaSearchStore(db.service);
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
      'zero-db-abcd',
    );
  const search = async (accountId: Id<'Account'>, query: string) => {
    const out = await new RecordEvent(gate, engagement).execute(customer(accountId), {
      event: { kind: 'search-performed', query },
      globalPrivacyControl: false,
    });
    expect(out).toEqual({ ok: true, value: { recorded: true } });
  };
  const note = async (key: string, at: Temporal.Instant) => {
    const out = await db.unitOfWork.run(market, async () => {
      await log.note(market, key, zeroResultBucketOf(at));
      return ok(true);
    });
    expect(out.ok).toBe(true);
  };
  const snapshot = () =>
    new SnapshotDailySearches(gate, {
      unitOfWork: db.unitOfWork,
      store,
      sources: new FacadeSearchSources(
        {
          zeroResultTexts: (context, request) =>
            new ZeroResultTextsOf(gate, {
              unitOfWork: db.unitOfWork,
              zeroResults: log,
              clock,
            }).execute(context, request),
        },
        {
          searchShoppers: (context, request) =>
            new CountSearchShoppers(gate, engagement).execute(context, request),
        },
      ),
      zone,
      clock,
    });
  const rowsOf = async () =>
    (
      await owner.query<Record<string, unknown>>(
        `SELECT query_text, searcher_count, search_count
           FROM reporting.daily_zero_result_searches
          WHERE market_id = $1 AND market_day = $2 ORDER BY query_text`,
        [market.marketId, DAY],
      )
    ).rows;

  it('writes the texts ten or more searched on a day they found nothing, once, through an opt-out', async () => {
    const ten = Array.from({ length: 10 }, () => ids.next<'Account'>());
    // Ten accounts, in mixed case, and one of them twice: ten searchers, eleven searches.
    for (const [n, account] of ten.entries()) {
      clock.set(noon.add({ minutes: n }));
      await search(account, n % 2 === 0 ? 'Sangak Bread' : 'sangak bread');
    }
    await search(ten[0]!, 'SANGAK BREAD');
    // Nine accounts and a guest: below the minimum.
    for (const account of ten.slice(0, 9)) await search(account, 'barberry');
    const guest = await new RecordGuestEvent(gate, engagement).execute(
      testCallContext(market, 'anonymous'),
      {
        event: { kind: 'search-performed', query: 'barberry' },
        consent: true,
        token: null,
        globalPrivacyControl: false,
      },
    );
    expect(guest).toMatchObject({ ok: true, value: { recorded: true } });
    // Ten searched it, but search found something for it that day: never written.
    for (const account of ten) await search(account, 'sumac');
    await note('sangak bread', noon);
    await note('sangak bread', noon.add({ minutes: 1 })); // the same quarter hour: one row
    await note('barberry', noon);
    const notes = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM search.zero_result_queries
        WHERE market_id = $1 AND query_key = 'sangak bread'`,
      [market.marketId],
    );
    expect(notes.rows).toEqual([{ n: '1' }]);

    clock.set(dayStart.add({ days: 1, hours: 2 }).toInstant());
    const first = await snapshot().execute(system, {});
    expect(first.ok && first.value.failedDays).toBe(0);
    expect(await rowsOf()).toEqual([
      { query_text: 'sangak bread', searcher_count: 10, search_count: 11 },
    ]);

    // One searcher switches personalization off: their behaviour goes, the day's row stays.
    const off = await new SetPersonalization(gate, engagement).execute(customer(ten[1]!), {
      enabled: false,
    });
    expect(off.ok).toBe(true);
    const again = await snapshot().execute(system, {});
    expect(again.ok && again.value.written).toBe(0);
    expect(await rowsOf()).toEqual([
      { query_text: 'sangak bread', searcher_count: 10, search_count: 11 },
    ]);

    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    const read = new ViewMarketplaceZeroResultSearches(gate, {
      unitOfWork: db.unitOfWork,
      store,
      zone,
      clock,
    });
    const answer = await read.execute(admin, { period: { from: DAY, to: DAY } });
    expect(answer.ok && answer.value.searches).toEqual({
      status: 'available',
      queries: [{ query: 'sangak bread', searches: 11, searcherDays: 10, days: 1 }],
      recordedDays: 1,
      periodDays: 1,
    });
  });

  it('purges search’s notes older than 35 days and keeps the rest', async () => {
    const old = '2026-03-01T00:00:00Z';
    await note('old text', Temporal.Instant.from(old));
    await note('recent text', clock.now());
    const purged = await new PurgeZeroResultQueries(gate, {
      unitOfWork: db.unitOfWork,
      zeroResults: log,
      clock,
    }).execute(system, {});
    expect(purged.ok && purged.value.deleted).toBeGreaterThanOrEqual(1);
    const left = await owner.query<{ query_key: string }>(
      `SELECT query_key FROM search.zero_result_queries
        WHERE market_id = $1 AND query_key IN ('old text', 'recent text')`,
      [market.marketId],
    );
    expect(left.rows).toEqual([{ query_key: 'recent text' }]);
  });

  it('reads and purges only the rows of its own tenant (Hassan I2, Mojtaba L4)', async () => {
    const otherTenant = 'other-tenant';
    const old = Temporal.Instant.from('2026-03-01T00:00:00Z');
    await owner.query(
      `INSERT INTO search.zero_result_queries (market_id, tenant_id, bucket_start, query_key)
       VALUES ($1, $2, $3, 'other tenant text')`,
      [market.marketId, otherTenant, old.toString()],
    );
    const purged = await new PurgeZeroResultQueries(gate, {
      unitOfWork: db.unitOfWork,
      zeroResults: log,
      clock,
    }).execute(system, {});
    expect(purged.ok).toBe(true);
    const kept = await owner.query(
      `SELECT tenant_id FROM search.zero_result_queries
        WHERE market_id = $1 AND query_key = 'other tenant text'`,
      [market.marketId],
    );
    expect(kept.rows).toEqual([{ tenant_id: otherTenant }]);

    // Another tenant's search of the same text is not counted with this tenant's.
    clock.set(noon);
    await owner.query(
      `INSERT INTO engagement.behaviour_events
         (id, market_id, tenant_id, account_id, kind, search_query, occurred_at)
       VALUES ($1, $2, $3, $4, 'search-performed', 'cumin seeds', $5)`,
      [ids.next(), market.marketId, otherTenant, ids.next(), noon.toString()],
    );
    const mine = ids.next<'Account'>();
    await search(mine, 'cumin seeds');
    const pairs = await db.unitOfWork.run(
      market,
      async () =>
        ok(
          await engagement.events.searchPairs(
            market,
            { from: dayStart.toInstant(), to: dayStart.add({ days: 1 }).toInstant() },
            ['cumin seeds'],
            100,
          ),
        ),
      { readOnly: true },
    );
    expect(pairs.ok && pairs.value).toEqual([
      expect.objectContaining({ query: 'cumin seeds', accountId: mine }),
    ]);
  });

  it('lets the application role only read and insert the reporting rows, and holds the minimum', async () => {
    for (const table of ['search_snapshot_days', 'daily_zero_result_searches']) {
      await expect(
        app.query(`UPDATE reporting.${table} SET recorded_at = now() WHERE market_id = $1`, [
          market.marketId,
        ]),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(
        app.query(`DELETE FROM reporting.${table} WHERE market_id = $1`, [market.marketId]),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
    await expect(
      app.query(`UPDATE search.zero_result_queries SET query_key = 'x' WHERE market_id = $1`, [
        market.marketId,
      ]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    const insert = (text: string, searchers: number, searches: number) =>
      owner.query(
        `INSERT INTO reporting.daily_zero_result_searches
           (market_id, tenant_id, market_day, query_text, searcher_count, search_count, recorded_at)
         VALUES ($1, $2, '2026-06-01', $3, $4, $5, now())`,
        [market.marketId, market.tenantId, text, searchers, searches],
      );
    await expect(insert('nine people', 9, 9)).rejects.toMatchObject({ code: CHECK });
    await expect(insert('fewer searches', 12, 11)).rejects.toMatchObject({ code: CHECK });
    await expect(insert('x', 10, 10)).rejects.toMatchObject({ code: CHECK });
    for (const text of ['jane@example.com', 'https://shop.example', 'WWW.example']) {
      await expect(insert(text, 10, 10)).rejects.toMatchObject({ code: CHECK });
    }
    const note = (key: string, bucket: string) =>
      owner.query(
        `INSERT INTO search.zero_result_queries (market_id, tenant_id, bucket_start, query_key)
         VALUES ($1, $2, $3, $4)`,
        [market.marketId, market.tenantId, bucket, key],
      );
    for (const key of ['jane@example.com', 'ftp://files.example', 'www.example']) {
      await expect(note(key, '2026-06-01T00:00:00Z')).rejects.toMatchObject({ code: CHECK });
    }
    await expect(note('off quarter', '2026-06-01T00:07:00Z')).rejects.toMatchObject({
      code: CHECK,
    });
    // A day written twice keeps the first rows.
    const day = '2026-06-02' as MarketDay;
    const twice = await db.unitOfWork.run(market, async () =>
      ok([
        await store.insertDay(
          market,
          day,
          [{ query: 'saffron', searchers: 10, searches: 12 }],
          clock.now(),
        ),
        await store.insertDay(
          market,
          day,
          [{ query: 'saffron', searchers: 50, searches: 90 }],
          clock.now(),
        ),
      ]),
    );
    expect(twice.ok && twice.value).toEqual([true, false]);
    const kept = await owner.query(
      `SELECT searcher_count FROM reporting.daily_zero_result_searches
        WHERE market_id = $1 AND market_day = $2`,
      [market.marketId, day],
    );
    expect(kept.rows).toEqual([{ searcher_count: 10 }]);
  });
});
