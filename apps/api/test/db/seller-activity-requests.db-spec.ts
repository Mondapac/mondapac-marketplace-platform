import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaSellerActivityRequestRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-activity-request.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { sqlState } from './sql-state';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// A seller's own request for business activities (BUG-012 step 2) on PostgreSQL, for both Market
// fixtures: one row per seller, replaced on each save, the CHECKs, Market isolation and the
// least-privilege grants as the application role. Sellers are inserted as the application role
// and removed as the owner at the end.

const T0 = Temporal.Instant.from('2026-11-28T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-28T01:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('seller activity requests in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const created: string[] = [];
  let persistence: Persistence;
  let repository: PrismaSellerActivityRequestRepository;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    persistence = createPersistence();
    repository = new PrismaSellerActivityRequestRepository(persistence.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await Promise.all([sql.connect(), owner.connect()]);
  });
  afterAll(async () => {
    for (const sellerId of created) {
      for (const table of ['seller_activity_requests', 'seller_admin_settings', 'seller_files']) {
        await owner.query(`DELETE FROM sellers.${table} WHERE seller_id = $1`, [sellerId]);
      }
    }
    await Promise.all([sql.end(), owner.end(), persistence.close()]);
  });

  const inUnitOf =
    (target: typeof market) =>
    <T>(work: () => Promise<T>): Promise<T> =>
      persistence.unitOfWork
        .run(target, async () => ({ ok: true as const, value: await work() }))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });
  const inUnit = inUnitOf(market);

  async function insertSeller(target = market): Promise<Id<'Seller'>> {
    const sellerId = uuid7();
    created.push(sellerId);
    await sql.query(
      `INSERT INTO sellers.seller_files
         (seller_id, market_id, tenant_id, origin, approval_required_at_registration,
          draft_complete, last_changed_at, version, created_at)
       VALUES ($1, $2, $3, 'self', true, false, now(), 1, now())`,
      [sellerId, target.marketId, target.tenantId],
    );
    return sellerId as Id<'Seller'>;
  }

  const next = (main: string, extras: string[] = [], at = T0) => ({
    mainActivityId: main as Id<'BusinessActivity'>,
    extraActivityIds: extras as Id<'BusinessActivity'>[],
    by: uuid7() as Id<'Account'>,
    at,
  });

  it('saves a request, reads it back, and replaces it on the next save', async () => {
    const sellerId = await insertSeller();
    const [a, b, c] = [uuid7(), uuid7(), uuid7()];
    expect(await inUnit(() => repository.find(market, sellerId))).toBeNull();

    await inUnit(() => repository.save(market, sellerId, next(a, [c, b])));
    expect(await inUnit(() => repository.find(market, sellerId))).toEqual({
      mainActivityId: a,
      extraActivityIds: [b, c].sort(),
      requestedAt: T0,
    });

    await inUnit(() => repository.save(market, sellerId, next(c, [], T1)));
    expect(await inUnit(() => repository.find(market, sellerId))).toEqual({
      mainActivityId: c,
      extraActivityIds: [],
      requestedAt: T1,
    });
    const rows = await sql.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sellers.seller_activity_requests WHERE seller_id = $1',
      [sellerId],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("never reads another Market's request", async () => {
    const sellerId = await insertSeller();
    await inUnit(() => repository.save(market, sellerId, next(uuid7())));
    expect(await inUnitOf(other)(() => repository.find(other, sellerId))).toBeNull();
  });

  it('refuses a main activity repeated in the extras, and more than nine extras', async () => {
    const sellerId = await insertSeller();
    const a = uuid7();
    const insert = (extras: string[]) =>
      sqlState(
        sql,
        `INSERT INTO sellers.seller_activity_requests
           (market_id, tenant_id, seller_id, main_activity_id, extra_activity_ids, requested_by, requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [market.marketId, market.tenantId, sellerId, a, extras, uuid7(), T0.toString()],
      );
    expect(await insert([a])).toBe('23514');
    expect(await insert(Array.from({ length: 10 }, uuid7))).toBe('23514');
    expect(await insert([uuid7()])).toBeNull();
  });

  it('grants the application role insert, select and the value columns only', async () => {
    const sellerId = await insertSeller();
    await inUnit(() => repository.save(market, sellerId, next(uuid7())));
    expect(
      await sqlState(sql, 'DELETE FROM sellers.seller_activity_requests WHERE seller_id = $1', [
        sellerId,
      ]),
    ).toBe('42501');
    expect(
      await sqlState(
        sql,
        'UPDATE sellers.seller_activity_requests SET seller_id = $2 WHERE seller_id = $1',
        [sellerId, uuid7()],
      ),
    ).toBe('42501');
  });
});
