import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaFlatFeeRepository } from '../../src/modules/shipping/infrastructure/prisma-flat-fee.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The flat shipping fee store (shipping.seller_flat_fees) as the application role, in both Market
// fixtures: insert then update, the batch read, the Market guard, and what the database refuses.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const CHECK = '23514';

describe.each(TEST_MARKETS)('flat fee repository in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let db: Persistence;
  let repository: PrismaFlatFeeRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaFlatFeeRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  it('inserts a fee, then updates it, and reads it back', async () => {
    const sellerId = ids.next<'Seller'>();
    const by = ids.next<'Account'>();

    expect(await value(market, () => repository.find(market, sellerId))).toBeNull();
    await value(market, () =>
      repository.save(market, {
        sellerId,
        fee: money(995n, currency),
        updatedAt: T0,
        updatedBy: by,
      }),
    );
    await value(market, () =>
      repository.save(market, {
        sellerId,
        fee: money(0n, currency),
        updatedAt: T0.add({ hours: 1 }),
        updatedBy: by,
      }),
    );

    const read = await value(market, () => repository.find(market, sellerId));
    expect(read?.fee).toEqual(money(0n, currency));
    expect(read?.updatedAt.toString()).toBe(T0.add({ hours: 1 }).toString());
  });

  it('reads many fees at once and never across Markets', async () => {
    const a = ids.next<'Seller'>();
    const b = ids.next<'Seller'>();
    const by = ids.next<'Account'>();
    for (const [sellerId, amount] of [
      [a, 100n],
      [b, 200n],
    ] as const) {
      await value(market, () =>
        repository.save(market, {
          sellerId,
          fee: money(amount, currency),
          updatedAt: T0,
          updatedBy: by,
        }),
      );
    }

    const here = await value(market, () =>
      repository.findMany(market, [a, b, ids.next<'Seller'>()]),
    );
    const there = await value(other, () => repository.findMany(other, [a, b]));

    expect(here.map((r) => r.fee.amount).sort()).toEqual([100n, 200n]);
    expect(there).toEqual([]);
    expect(await value(other, () => repository.find(other, a))).toBeNull();
  });

  it('refuses what the application never writes', async () => {
    const attempt = (amount: number, cur: string) =>
      sql
        .query(
          `INSERT INTO shipping.seller_flat_fees (market_id, seller_id, tenant_id, amount, currency, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, now(), $6)`,
          [market.marketId, ids.next(), market.tenantId, amount, cur, ids.next()],
        )
        .then(
          () => 'allowed',
          (error: { code?: string }) => error.code,
        );

    expect(await attempt(-1, currency)).toBe(CHECK);
    expect(await attempt(100001, currency)).toBe(CHECK);
    expect(await attempt(100, 'aud')).toBe(CHECK);
    expect(await attempt(100, currency)).toBe('allowed');
    expect(
      await sql.query(`DELETE FROM shipping.seller_flat_fees`).then(
        () => 'allowed',
        (e: { code?: string }) => e.code,
      ),
    ).toBe('42501');
  });
});
