import { Temporal, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SellerFile } from '../../src/modules/sellers/domain/seller-file';
import { computeSellerHealth } from '../../src/modules/sellers/domain/seller-health';
import type { SellerHealthDay } from '../../src/modules/sellers/domain/seller-health-days';
import { PrismaSellerFileRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-file.repository';
import { PrismaSellerHealthStore } from '../../src/modules/sellers/infrastructure/prisma-seller-health.store';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The seller health store on PostgreSQL (seller health package 3), for both Market fixtures, as
// the application role: the counters of a local day and the daily snapshot are set and replaced
// without counting twice, read back by date range, kept apart by Market and seller, and the
// CHECKs refuse a late order that was not ready, stars outside 1 to 5, and a half-scored snapshot.

const T0 = Temporal.Instant.from('2026-11-10T01:00:00Z');
const CHECK = '23514';
const day = (iso: string, patch: Partial<SellerHealthDay> = {}): SellerHealthDay => ({
  day: Temporal.PlainDate.from(iso),
  paidOrders: 12,
  readyOrders: 10,
  lateReadyOrders: 2,
  lostDisputes: 1,
  reviewsApproved: 3,
  ratingStarsSum: 13,
  ...patch,
});

describe.each(TEST_MARKETS)('the seller health store in market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let sql: Client;
  let files: PrismaSellerFileRepository;
  let store: PrismaSellerHealthStore;

  beforeAll(async () => {
    db = createPersistence();
    files = new PrismaSellerFileRepository(db.service);
    store = new PrismaSellerHealthStore(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  async function newSeller(m: MarketContext = market): Promise<Id<'Seller'>> {
    clock.advance(Temporal.Duration.from({ milliseconds: 2 }));
    const sellerId = ids.next<'Seller'>();
    const created = await db.unitOfWork.run(m, async () =>
      ok(
        await files.addWithRoots(
          m,
          SellerFile.create({
            sellerId,
            marketId: m.marketId,
            origin: 'self',
            approvalRequiredAtRegistration: true,
            now: T0,
          }),
        ),
      ),
    );
    if (!created.ok) throw new Error('unreachable');
    return sellerId;
  }

  const run = <T>(m: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork
      .run(m, async () => ok(await work()))
      .then((r) => {
        if (!r.ok) throw new Error('unit failed');
        return r.value;
      });

  it('sets a day, replaces it on a repeat and reads a date range', async () => {
    const seller = await newSeller();
    await run(market, () => store.saveDay(market, seller, day('2026-11-09'), T0));
    await run(market, () => store.saveDay(market, seller, day('2026-11-10'), T0));
    await run(market, () =>
      store.saveDay(market, seller, day('2026-11-10', { paidOrders: 20 }), T0.add({ hours: 1 })),
    );
    const rows = await run(market, () =>
      store.days(
        market,
        seller,
        Temporal.PlainDate.from('2026-11-09'),
        Temporal.PlainDate.from('2026-11-10'),
      ),
    );
    expect(rows.map((r) => [r.day.toString(), r.paidOrders])).toEqual([
      ['2026-11-09', 12],
      ['2026-11-10', 20],
    ]);
    const narrow = await run(market, () =>
      store.days(
        market,
        seller,
        Temporal.PlainDate.from('2026-11-10'),
        Temporal.PlainDate.from('2026-11-10'),
      ),
    );
    expect(narrow).toHaveLength(1);
  });

  it('keeps sellers and Markets apart', async () => {
    const seller = await newSeller();
    const stranger = await newSeller(other);
    await run(market, () => store.saveDay(market, seller, day('2026-11-10'), T0));
    const mine = Temporal.PlainDate.from('2026-11-10');
    expect(await run(other, () => store.days(other, stranger, mine, mine))).toEqual([]);
    expect(await run(market, () => store.days(market, seller, mine, mine))).toHaveLength(1);
  });

  it('stores a scored snapshot and reads it back whole', async () => {
    const seller = await newSeller();
    const inputs = {
      orders: 40,
      sellerCancellations: { count: 0, base: 0 },
      lateReady: { count: 3, base: 40 },
      lostDisputes: { count: 0, base: 40 },
      customerRating: { count: 8, averageHundredths: 460 },
      reports: null,
    };
    const health = computeSellerHealth(inputs, {
      minOrders: 10,
      minReviews: 5,
      sellerCancellations: { healthyBelow: 250, atRiskUpTo: 500, zeroAt: 1000 },
      lateReady: { healthyBelow: 400, atRiskUpTo: 1000, zeroAt: 2000 },
      lostDisputes: { healthyBelow: 50, atRiskUpTo: 100, zeroAt: 200 },
      customerRating: { healthyFrom: 400, atRiskFrom: 350, best: 500, zeroAt: 100 },
      reports: { healthyBelow: 1, atRiskUpTo: 2, zeroAt: 5 },
    });
    const snapshot = { day: Temporal.PlainDate.from('2026-11-10'), health, inputs, computedAt: T0 };
    await run(market, () => store.saveSnapshot(market, seller, snapshot));
    await run(market, () => store.saveSnapshot(market, seller, snapshot));
    const back = await run(market, () =>
      store.snapshots(market, seller, snapshot.day, snapshot.day),
    );
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(snapshot);
  });

  it('stores a New snapshot without a score', async () => {
    const seller = await newSeller();
    const inputs = {
      orders: 2,
      sellerCancellations: { count: 0, base: 0 },
      lateReady: { count: 0, base: 2 },
      lostDisputes: { count: 0, base: 2 },
      customerRating: { count: 0, averageHundredths: 0 },
      reports: null,
    };
    const health = {
      kind: 'new' as const,
      metrics: [{ metric: 'late-ready' as const, kind: 'no-data' as const }],
      formulaVersion: 'v1',
    };
    const snapshot = { day: Temporal.PlainDate.from('2026-11-10'), health, inputs, computedAt: T0 };
    await run(market, () => store.saveSnapshot(market, seller, snapshot));
    const back = await run(market, () =>
      store.snapshots(market, seller, snapshot.day, snapshot.day),
    );
    expect(back[0]?.health).toMatchObject({ kind: 'new' });
  });

  it('refuses rows the rules forbid', async () => {
    const seller = await newSeller();
    const insert = (patch: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        market_id: market.marketId,
        tenant_id: market.tenantId,
        seller_id: seller,
        day: '2026-11-11',
        paid_orders: 5,
        ready_orders: 4,
        late_ready_orders: 1,
        lost_disputes: 0,
        reviews_approved: 2,
        rating_stars_sum: 9,
        recounted_at: T0.toString(),
        ...patch,
      };
      const keys = Object.keys(row);
      return sql
        .query(
          `INSERT INTO sellers.seller_health_days (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        )
        .then(
          () => 'ok',
          (error: { code?: string }) => error.code ?? 'error',
        );
    };
    expect(await insert({ late_ready_orders: 5 })).toBe(CHECK);
    expect(await insert({ rating_stars_sum: 11 })).toBe(CHECK);
    expect(await insert({ rating_stars_sum: 1 })).toBe(CHECK);
    expect(await insert({ paid_orders: -1 })).toBe(CHECK);
    expect(await insert({ day: '2026-11-12' })).toBe('ok');

    const snap = (patch: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        market_id: market.marketId,
        tenant_id: market.tenantId,
        seller_id: seller,
        day: '2026-11-13',
        kind: 'scored',
        band: 'healthy',
        score: 80,
        lowest_metric: 'late-ready',
        formula_version: 'v1',
        metrics: '{}',
        computed_at: T0.toString(),
        ...patch,
      };
      const keys = Object.keys(row);
      return sql
        .query(
          `INSERT INTO sellers.seller_health_snapshots (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        )
        .then(
          () => 'ok',
          (error: { code?: string }) => error.code ?? 'error',
        );
    };
    expect(await snap({ band: null })).toBe(CHECK);
    expect(await snap({ kind: 'new' })).toBe(CHECK);
    expect(await snap({ score: 101 })).toBe(CHECK);
    expect(await snap({ lowest_metric: 'speed' })).toBe(CHECK);
    expect(await snap({ kind: 'new', band: null, score: null, lowest_metric: null })).toBe('ok');
  });
});
