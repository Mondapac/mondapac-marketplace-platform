import { ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { CalendarMonth } from '../../src/modules/reporting/domain/month-forecast';
import { PrismaSellerGoalStore } from '../../src/modules/reporting/infrastructure/prisma-seller-goal-store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The sellers' monthly goals (dashboards v2 phase 2) on PostgreSQL as the application role, in
// both Market fixtures: the store reads and writes one seller's row of one Market only, a stale
// version writes nothing and leaves the unit usable, and the table's own guards (the CHECKs, the
// key, column-level UPDATE, no DELETE) hold.

const CURRENCIES: Record<string, string> = { AU: 'AUD', ZZ: 'JPY' };
const CHECK = '23514';
const UNIQUE = '23505';
const NO_PRIVILEGE = '42501';
let counter = 0;
const idOf = <T extends string>(): Id<T> => {
  const parsed = parseId<T>(
    uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10))),
  );
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};
const NOV = '2026-11' as CalendarMonth;
const DEC = '2026-12' as CalendarMonth;
const AT = Temporal.Instant.from('2026-11-15T03:00:00Z');

describe.each(TEST_MARKETS)('the seller monthly goals in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = CURRENCIES[code] as string;
  let db: Persistence;
  let store: PrismaSellerGoalStore;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence();
    store = new PrismaSellerGoalStore(db.service);
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

  const within = <T>(target: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork.run(target, async () => ok(await work()));
  const read = async (target: MarketContext, sellerId: Id<'Seller'>, month: CalendarMonth) => {
    const out = await db.unitOfWork.run(
      target,
      async () => ok(await store.find(target, sellerId, month)),
      { readOnly: true },
    );
    if (!out.ok) throw new Error('read failed');
    return out.value;
  };
  const change = (
    sellerId: Id<'Seller'>,
    month: CalendarMonth,
    amount: bigint,
    version: number,
  ) => ({
    sellerId,
    month,
    goal: { amount, currency },
    version,
    changedAt: AT,
  });
  const code_ = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );

  it('sets, reads and changes one seller goal of one month, from the version seen', async () => {
    const seller = idOf<'Seller'>();
    const canary = idOf<'Seller'>();
    expect(await within(market, () => store.save(market, change(seller, NOV, 8_000n, 1)))).toEqual({
      ok: true,
      value: true,
    });
    await within(market, () => store.save(market, change(canary, NOV, 99_000n, 1)));
    expect(await read(market, seller, NOV)).toEqual({
      month: NOV,
      goal: { amount: 8_000n, currency },
      version: 1,
      updatedAt: AT,
    });
    expect(await read(market, seller, DEC)).toBeNull();
    // The same seller id in another Market has no goal.
    expect(await read(other, seller, NOV)).toBeNull();
    // A second first-set and a stale change write nothing, and the unit goes on.
    const stale = await within(market, async () => {
      const again = await store.save(market, change(seller, NOV, 1n, 1));
      const behind = await store.save(market, change(seller, NOV, 2n, 3));
      const next = await store.save(market, change(seller, NOV, 9_000n, 2));
      return [again, behind, next];
    });
    expect(stale).toEqual({ ok: true, value: [false, false, true] });
    expect(await read(market, seller, NOV)).toMatchObject({ goal: { amount: 9_000n }, version: 2 });
    expect((await read(market, canary, NOV))?.goal.amount).toBe(99_000n);
  });

  const insert = (over: Record<string, unknown> = {}) => {
    const v = {
      market_id: market.marketId,
      tenant_id: 'default',
      seller_id: idOf<'Seller'>(),
      month: '2026-11-01',
      currency,
      amount: '100',
      version: 1,
      updated_at: new Date(),
      ...over,
    };
    const keys = Object.keys(v);
    return sql.query(
      `INSERT INTO reporting.seller_monthly_goals (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(v),
    );
  };

  it('refuses a bad market, tenant, month, currency, amount and version', async () => {
    expect(await code_(insert({ market_id: 'a' }))).toBe(CHECK);
    expect(await code_(insert({ tenant_id: 'Bad Tenant' }))).toBe(CHECK);
    expect(await code_(insert({ month: '2026-11-02' }))).toBe(CHECK);
    expect(await code_(insert({ currency: 'aud' }))).toBe(CHECK);
    expect(await code_(insert({ amount: '0' }))).toBe(CHECK);
    expect(await code_(insert({ amount: '1000000000000000' }))).toBe(CHECK);
    expect(await code_(insert({ version: 0 }))).toBe(CHECK);
    expect(await code_(insert({ amount: '999999999999999' }))).toBe('allowed');
  });

  it('keeps one row per Market, seller and month; changes only the goal and stamps; never deletes', async () => {
    const seller = idOf<'Seller'>();
    expect(await code_(insert({ seller_id: seller }))).toBe('allowed');
    expect(await code_(insert({ seller_id: seller }))).toBe(UNIQUE);
    expect(await code_(insert({ seller_id: seller, month: '2026-12-01' }))).toBe('allowed');
    expect(
      await code_(
        sql.query(
          `UPDATE reporting.seller_monthly_goals SET amount = 5, version = 2, updated_at = now() WHERE seller_id = $1`,
          [seller],
        ),
      ),
    ).toBe('allowed');
    for (const column of ['seller_id', 'month', 'market_id', 'tenant_id']) {
      expect(
        await code_(
          sql.query(
            `UPDATE reporting.seller_monthly_goals SET ${column} = ${column} WHERE seller_id = $1`,
            [seller],
          ),
        ),
      ).toBe(NO_PRIVILEGE);
    }
    expect(
      await code_(
        sql.query('DELETE FROM reporting.seller_monthly_goals WHERE seller_id = $1', [seller]),
      ),
    ).toBe(NO_PRIVILEGE);
    // The owner clears what the test wrote (the application cannot).
    await owner.query('DELETE FROM reporting.seller_monthly_goals WHERE market_id = $1', [
      market.marketId,
    ]);
  });
});
