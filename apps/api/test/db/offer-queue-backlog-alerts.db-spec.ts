import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { PrismaOfferQueueBacklogRepository } from '../../src/modules/notifications/infrastructure/prisma-offer-queue-backlog.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The Offer review queue backlog alerts (risk-based Offer approval, slice 8) on PostgreSQL, as the
// application role, for both Market fixtures: one open alert for each Market at a time (the
// partial unique index), closed once, then a new crossing may open again; one Market never sees
// or closes another's.

const T0 = Temporal.Instant.from('2031-03-01T00:00:00Z');
const ids = new UuidV7IdGenerator(new FixedClock(Temporal.Instant.from('2026-11-25T00:00:00Z')));

describe.each(TEST_MARKETS)('Offer queue backlog alerts in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let alerts: PrismaOfferQueueBacklogRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    alerts = new PrismaOfferQueueBacklogRepository(db.service);
    sql = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });
  beforeEach(async () => {
    await sql.query(
      `DELETE FROM notifications.offer_queue_backlog_alerts WHERE raised_at > '2031-01-01' AND raised_at < '2032-01-01'`,
    );
  });
  const unit = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  it('opens one alert for each Market until it is cleared, then opens again', async () => {
    expect(
      await unit(market, () =>
        alerts.raise(market, ids.next<'OfferQueueBacklogAlert'>(), T0, 'age', 12),
      ),
    ).toBe(true);
    expect(
      await unit(market, () =>
        alerts.raise(
          market,
          ids.next<'OfferQueueBacklogAlert'>(),
          T0.add({ minutes: 15 }),
          'size',
          80,
        ),
      ),
    ).toBe(false);
    expect(
      await unit(other, () =>
        alerts.raise(other, ids.next<'OfferQueueBacklogAlert'>(), T0, 'size', 70),
      ),
    ).toBe(true);
    expect(await unit(market, () => alerts.clear(market, T0.add({ hours: 1 })))).toBe(true);
    expect(await unit(market, () => alerts.clear(market, T0.add({ hours: 2 })))).toBe(false);
    expect(
      await unit(market, () =>
        alerts.raise(
          market,
          ids.next<'OfferQueueBacklogAlert'>(),
          T0.add({ hours: 3 }),
          'both',
          90,
        ),
      ),
    ).toBe(true);
    // The other Market's alert is still open.
    expect(
      await unit(other, () =>
        alerts.raise(other, ids.next<'OfferQueueBacklogAlert'>(), T0.add({ hours: 4 }), 'age', 1),
      ),
    ).toBe(false);
    const { rows } = await sql.query<{ market_id: string; reason: string; cleared: boolean }>(
      `SELECT market_id, reason, cleared_at IS NOT NULL AS cleared
         FROM notifications.offer_queue_backlog_alerts
        WHERE raised_at > '2031-01-01' ORDER BY market_id, raised_at`,
    );
    expect(rows.filter((row) => row.market_id === market.marketId)).toEqual([
      { market_id: market.marketId, reason: 'age', cleared: true },
      { market_id: market.marketId, reason: 'both', cleared: false },
    ]);
  });

  it('raises once when two runs overlap, and again at the same instant after a clear', async () => {
    const [first, second] = await Promise.all([
      unit(market, () => alerts.raise(market, ids.next<'OfferQueueBacklogAlert'>(), T0, 'age', 12)),
      unit(market, () => alerts.raise(market, ids.next<'OfferQueueBacklogAlert'>(), T0, 'age', 12)),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await unit(market, () => alerts.clear(market, T0))).toBe(true);
    // The same instant as the cleared alert: a new crossing is still raised.
    expect(
      await unit(market, () =>
        alerts.raise(market, ids.next<'OfferQueueBacklogAlert'>(), T0, 'size', 60),
      ),
    ).toBe(true);
  });

  it('refuses a reason outside age, size and both', async () => {
    await expect(
      sql.query(
        `INSERT INTO notifications.offer_queue_backlog_alerts (market_id, id, tenant_id, raised_at, reason, queue_size)
         VALUES ($1, '01990000-0000-7000-8000-0000000000aa', 'default', '2031-06-01T00:00:00Z', 'other', 1)`,
        [market.marketId],
      ),
    ).rejects.toThrow(/reason_check/);
  });
});
