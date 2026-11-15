import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { PrismaCustomerReadModelRepository } from '../../src/modules/customers/infrastructure/prisma-customer-read-models.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The customers read models as the application role, in both Market fixtures: a row is inserted
// and replaced (never added to), read back, kept apart per Market, removed together at erasure,
// and the CHECKs refuse what the application never writes.

const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const CHECK = '23514';
const ids = new UuidV7IdGenerator(new FixedClock(T0));

describe.each(TEST_MARKETS)('customers read models in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let repository: PrismaCustomerReadModelRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaCustomerReadModelRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const inUnit = async <T>(target: typeof market, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const entry = (accountId: Id<'Account'>, over = {}) => ({
    accountId,
    email: 'Sam@Example.com',
    displayName: 'Sam S.',
    status: 'active' as const,
    emailVerified: true,
    signedUpAt: T0.subtract({ hours: 48 }),
    ...over,
  });
  const stats = (accountId: Id<'Account'>, over = {}) => ({
    accountId,
    firstOrderAt: T0.subtract({ hours: 24 }),
    lastOrderAt: T0.subtract({ hours: 2 }),
    orderCount: 3,
    spentMinor: 45_000n,
    currency: 'AUD',
    refundCount: 1,
    refundedMinor: 500n,
    ...over,
  });

  it('stores, replaces and reads back, keeping the Markets apart', async () => {
    const account = ids.next<'Account'>();
    await inUnit(market, async () => {
      await repository.upsertDirectory(market, entry(account), T0);
      await repository.upsertStats(market, stats(account), T0);
    });
    await inUnit(market, async () => {
      await repository.upsertDirectory(market, entry(account, { status: 'disabled' }), T0);
      await repository.upsertStats(
        market,
        stats(account, { orderCount: 4, spentMinor: 60_000n }),
        T0,
      );
    });
    expect(await inUnit(market, () => repository.hasDirectory(market, account))).toBe(true);
    expect(await inUnit(other, () => repository.hasDirectory(other, account))).toBe(false);
    const read = await inUnit(market, () => repository.findStats(market, account));
    expect(read).toMatchObject({ orderCount: 4, spentMinor: 60_000n, refundedMinor: 500n });
    expect(read?.lastOrderAt?.epochMilliseconds).toBe(T0.subtract({ hours: 2 }).epochMilliseconds);
    const rows = await sql.query<{ status: string; email_lower: string }>(
      'SELECT status, email_lower FROM customers.customer_directory WHERE market_id = $1 AND account_id = $2',
      [market.marketId, account],
    );
    expect(rows.rows).toEqual([{ status: 'disabled', email_lower: 'sam@example.com' }]);
  });

  it('gives a never-ordered customer a zero stats row and leaves an existing row alone', async () => {
    const fresh = ids.next<'Account'>();
    const known = ids.next<'Account'>();
    await inUnit(market, async () => {
      await repository.upsertDirectory(market, entry(fresh), T0);
      await repository.upsertDirectory(market, entry(known), T0);
      await repository.upsertStats(market, stats(known), T0);
      await repository.ensureStats(market, fresh, T0);
      await repository.ensureStats(market, known, T0);
    });
    expect(await inUnit(market, () => repository.findStats(market, fresh))).toMatchObject({
      orderCount: 0,
      spentMinor: 0n,
      lastOrderAt: null,
    });
    expect(await inUnit(market, () => repository.findStats(market, known))).toMatchObject({
      orderCount: 3,
      spentMinor: 45_000n,
    });
  });

  it('removes both rows of one account and no other', async () => {
    const gone = ids.next<'Account'>();
    const kept = ids.next<'Account'>();
    await inUnit(market, async () => {
      for (const account of [gone, kept]) {
        await repository.upsertDirectory(market, entry(account), T0);
        await repository.upsertStats(market, stats(account), T0);
      }
      await repository.removeAllOf(market, gone);
    });
    expect(await inUnit(market, () => repository.hasDirectory(market, gone))).toBe(false);
    expect(await inUnit(market, () => repository.findStats(market, gone))).toBeNull();
    expect(await inUnit(market, () => repository.hasDirectory(market, kept))).toBe(true);
  });

  it('refuses a status, a count and an order instant pair the application never writes', async () => {
    const account = ids.next<'Account'>();
    await expect(
      inUnit(market, () =>
        repository.upsertDirectory(market, entry(account, { status: 'banned' as never }), T0),
      ),
    ).rejects.toBeDefined();
    await expect(
      inUnit(market, () =>
        repository.upsertStats(market, stats(account, { orderCount: 0, firstOrderAt: T0 }), T0),
      ),
    ).rejects.toBeDefined();
    const direct = await sql
      .query(
        `INSERT INTO customers.customer_stats (market_id, tenant_id, account_id, order_count, spent_minor, refund_count, refunded_minor, computed_at)
         VALUES ($1, 'default', $2, -1, 0, 0, 0, now())`,
        [market.marketId, account],
      )
      .catch((error: { code?: string }) => error);
    expect((direct as { code?: string }).code).toBe(CHECK);
  });
});
