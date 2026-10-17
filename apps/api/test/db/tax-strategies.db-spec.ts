import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaStrategyRepository } from '../../src/modules/tax/infrastructure/prisma-strategy.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The tax strategy store as the application role, in both Market fixtures: define, change,
// switch on and off, remove; at most one active strategy per Market (the partial unique index);
// the value CHECKs; and never a read across Markets.

const T0 = Temporal.Instant.from('2026-10-16T10:00:00Z');
const CHECK = '23514';
// Prisma reports a violated unique index as P2002.
const UNIQUE = 'P2002';

describe.each(TEST_MARKETS)('tax strategy store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const by = ids.next<'Account'>();
  const stamp = (hours: number) => ({ updatedAt: T0.add({ hours }), updatedBy: by });
  let db: Persistence;
  let strategies: PrismaStrategyRepository;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence();
    strategies = new PrismaStrategyRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });
  // Each test starts with no active strategy in the Market.
  beforeEach(async () => {
    await value(market, () => strategies.deactivateAll(market, stamp(0)));
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const code_ = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  const insert = (id: Id<'TaxStrategy'>, name = 'GST') =>
    value(market, () =>
      strategies.insert(market, {
        id,
        name,
        params: { kind: 'flat-rate', rateBps: 1000 },
        createdAt: T0,
        updatedBy: by,
      }),
    );

  it('inserts, reads, changes and removes a strategy, and never reads across Markets', async () => {
    const id = ids.next<'TaxStrategy'>();
    await insert(id);
    const read = await value(market, () => strategies.find(market, id));
    expect(read).toMatchObject({
      id,
      name: 'GST',
      params: { kind: 'flat-rate', rateBps: 1000 },
      active: false,
    });
    expect((await value(market, () => strategies.list(market))).map((r) => r.id)).toContain(id);
    expect(await value(other, () => strategies.find(other, id))).toBeNull();
    expect((await value(other, () => strategies.list(other))).map((r) => r.id)).not.toContain(id);

    await value(market, () =>
      strategies.update(market, {
        id,
        name: 'By category',
        params: { kind: 'by-category', defaultRateBps: 1000, categoryRatesBps: { gst_free: 0 } },
        updatedAt: T0.add({ hours: 1 }),
        updatedBy: by,
      }),
    );
    const changed = await value(market, () => strategies.findForUpdate(market, id));
    expect(changed).toMatchObject({
      name: 'By category',
      params: { kind: 'by-category', defaultRateBps: 1000, categoryRatesBps: { gst_free: 0 } },
    });
    expect(changed?.updatedAt.toString()).toBe(T0.add({ hours: 1 }).toString());
    expect(await value(other, () => strategies.findForUpdate(other, id))).toBeNull();
    expect(await value(other, () => strategies.remove(other, id))).toBe(false);

    expect(await value(market, () => strategies.remove(market, id))).toBe(true);
    expect(await value(market, () => strategies.find(market, id))).toBeNull();
  });

  it('keeps at most one active strategy per Market', async () => {
    const a = ids.next<'TaxStrategy'>();
    const b = ids.next<'TaxStrategy'>();
    await insert(a, 'A');
    await insert(b, 'B');
    await value(market, () => strategies.activate(market, a, stamp(1)));
    expect((await value(market, () => strategies.findActive(market)))?.id).toBe(a);
    expect(await code_(value(market, () => strategies.activate(market, b, stamp(2))))).toBe(UNIQUE);

    expect(await value(market, () => strategies.deactivateAll(market, stamp(3)))).toBe(true);
    expect(await value(market, () => strategies.deactivateAll(market, stamp(3)))).toBe(false);
    await value(market, () => strategies.activate(market, b, stamp(4)));
    expect((await value(market, () => strategies.findActive(market)))?.id).toBe(b);
    // The other Market has its own active strategy.
    expect(await value(other, () => strategies.findActive(other))).toBeNull();
  });

  it('refuses a damaged row, a bad kind, name and scope at the database', async () => {
    const insertRow = (
      kind: string,
      name: string,
      marketId: string = market.marketId,
      config = '{}',
    ) =>
      code_(
        sql.query(
          `INSERT INTO tax.tax_strategies (id, market_id, tenant_id, name, kind, config, active, created_at, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, false, now(), now(), $7)`,
          [ids.next(), marketId, market.tenantId, name, kind, config, by],
        ),
      );
    expect(await insertRow('compound', 'x')).toBe(CHECK);
    expect(await insertRow('flat-rate', '')).toBe(CHECK);
    expect(await insertRow('flat-rate', 'x'.repeat(81))).toBe(CHECK);
    expect(await insertRow('flat-rate', 'x', 'bad mkt')).toBe(CHECK);
    expect(await insertRow('flat-rate', 'x', market.marketId, '[]')).toBe(CHECK);
    expect(await insertRow('flat-rate', 'x', market.marketId, '{"rateBps":1}')).toBe('allowed');
  });

  it('reads a damaged stored shape as an error instead of guessing the tax', async () => {
    const id = ids.next<'TaxStrategy'>();
    await owner.query(
      `INSERT INTO tax.tax_strategies (id, market_id, tenant_id, name, kind, config, active, created_at, updated_at, updated_by)
       VALUES ($1, $2, $3, 'Damaged', 'flat-rate', '{"rateBps":"x"}'::jsonb, false, now(), now(), $4)`,
      [id, market.marketId, market.tenantId, by],
    );
    await expect(value(market, () => strategies.find(market, id))).rejects.toThrow(
      'tax.stored-strategy-invalid',
    );
    await owner.query(`DELETE FROM tax.tax_strategies WHERE id = $1`, [id]);
  });
});
