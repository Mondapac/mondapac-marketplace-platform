import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaSellerBusinessActivityRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-business-activity.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { sqlState } from './sql-state';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// A seller's business activities (ADR-0040 decision 4; package 4a) on PostgreSQL, for both Market
// fixtures: the constraints of the assignment table and the change log, one main per seller, the
// repository (whole-set replacement, lock, Market isolation, last change) and the least-privilege
// grants as the application role. Sellers are inserted as the application role (the file and its
// settings row) and removed as the owner at the end.

const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-02T01:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)(
  'seller business activities in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    const created: string[] = [];
    let persistence: Persistence;
    let repository: PrismaSellerBusinessActivityRepository;
    let sql: Client;
    let owner: Client;

    beforeAll(async () => {
      persistence = createPersistence();
      repository = new PrismaSellerBusinessActivityRepository(persistence.service);
      sql = new Client({ connectionString: testDatabaseUrl() });
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await Promise.all([sql.connect(), owner.connect()]);
    });
    afterAll(async () => {
      for (const sellerId of created) {
        for (const table of [
          'seller_business_activities',
          'seller_business_activity_changes',
          'seller_admin_settings',
          'seller_files',
        ]) {
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

    /** A seller file with its settings row, in the given Market. */
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
      await sql.query(
        `INSERT INTO sellers.seller_admin_settings
           (seller_id, market_id, tenant_id, all_product_types_allowed, category_proposals_allowed,
            ai_enabled, version, created_at)
         VALUES ($1, $2, $3, true, false, false, 1, now())`,
        [sellerId, target.marketId, target.tenantId],
      );
      return sellerId as Id<'Seller'>;
    }

    const insertRow = (
      sellerId: string,
      activityId: string,
      isMain: boolean,
      overrides: Record<string, unknown> = {},
    ) => {
      const row = {
        market_id: market.marketId,
        tenant_id: market.tenantId,
        seller_id: sellerId,
        activity_id: activityId,
        is_main: isMain,
        assigned_by: uuid7(),
        assigned_at: T0.toString(),
        ...overrides,
      };
      const columns = Object.keys(row);
      return sqlState(
        sql,
        `INSERT INTO sellers.seller_business_activities (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    const next = (main: string, extras: string[] = []) => ({
      mainActivityId: main as Id<'BusinessActivity'>,
      extraActivityIds: extras as Id<'BusinessActivity'>[],
      by: uuid7() as Id<'Account'>,
      at: T0,
    });

    it('replaces the whole set and reads it back, main apart from extras', async () => {
      const sellerId = await insertSeller();
      const [a, b, c] = [uuid7(), uuid7(), uuid7()];
      expect(await inUnit(() => repository.find(market, [sellerId]))).toEqual(new Map());

      await inUnit(() => repository.replace(market, sellerId, next(a, [c, b].sort())));
      expect((await inUnit(() => repository.find(market, [sellerId]))).get(sellerId)).toEqual({
        mainActivityId: a,
        extraActivityIds: [b, c].sort(),
      });

      await inUnit(() => repository.replace(market, sellerId, next(c)));
      expect((await inUnit(() => repository.find(market, [sellerId]))).get(sellerId)).toEqual({
        mainActivityId: c,
        extraActivityIds: [],
      });
      const rows = await sql.query(
        'SELECT activity_id, is_main FROM sellers.seller_business_activities WHERE seller_id = $1',
        [sellerId],
      );
      expect(rows.rows).toEqual([{ activity_id: c, is_main: true }]);
    });

    it('keeps an assignment inside its Market', async () => {
      const sellerId = await insertSeller();
      await inUnit(() => repository.replace(market, sellerId, next(uuid7())));
      expect(await inUnitOf(other)(() => repository.find(other, [sellerId]))).toEqual(new Map());
      expect(await inUnitOf(other)(() => repository.lock(other, sellerId))).toBe(false);
      expect(await inUnit(() => repository.lock(market, sellerId))).toBe(true);
      expect(await inUnit(() => repository.lock(market, uuid7() as Id<'Seller'>))).toBe(false);
    });

    it('logs who changed what and why, and reads the latest change', async () => {
      const sellerId = await insertSeller();
      const [a, b] = [uuid7(), uuid7()];
      const admin = uuid7() as Id<'Account'>;
      expect(await inUnit(() => repository.lastChange(market, sellerId))).toBeNull();
      await inUnit(() =>
        repository.appendChange(market, {
          id: uuid7() as Id<'SellerActivityChange'>,
          sellerId,
          by: admin,
          at: T0,
          reason: 'first',
          before: { mainActivityId: null, extraActivityIds: [] },
          after: { mainActivityId: a as Id<'BusinessActivity'>, extraActivityIds: [] },
        }),
      );
      await inUnit(() =>
        repository.appendChange(market, {
          id: uuid7() as Id<'SellerActivityChange'>,
          sellerId,
          by: admin,
          at: T1,
          reason: 'second',
          before: { mainActivityId: a as Id<'BusinessActivity'>, extraActivityIds: [] },
          after: {
            mainActivityId: b as Id<'BusinessActivity'>,
            extraActivityIds: [a as Id<'BusinessActivity'>],
          },
        }),
      );
      expect(await inUnit(() => repository.lastChange(market, sellerId))).toEqual({
        changedBy: admin,
        changedAt: T1,
        reason: 'second',
      });
      const rows = await sql.query(
        `SELECT before_main_id, before_extra_ids, after_main_id, after_extra_ids
           FROM sellers.seller_business_activity_changes WHERE seller_id = $1 ORDER BY changed_at`,
        [sellerId],
      );
      expect(rows.rows).toEqual([
        { before_main_id: null, before_extra_ids: [], after_main_id: a, after_extra_ids: [] },
        { before_main_id: a, before_extra_ids: [], after_main_id: b, after_extra_ids: [a] },
      ]);
    });

    it('allows at most one main activity per seller, and one row per activity', async () => {
      const sellerId = await insertSeller();
      const [a, b, c] = [uuid7(), uuid7(), uuid7()];
      expect(await insertRow(sellerId, a, true)).toBeNull();
      expect(await insertRow(sellerId, b, true)).toBe('23505');
      expect(await insertRow(sellerId, b, false)).toBeNull();
      expect(await insertRow(sellerId, c, false)).toBeNull();
      expect(await insertRow(sellerId, a, false)).toBe('23505');
      // Another seller may have its own main.
      const second = await insertSeller();
      expect(await insertRow(second, a, true)).toBeNull();
    });

    it('refuses a bad Market or tenant, an unknown seller and a seller of another Market', async () => {
      const sellerId = await insertSeller();
      expect(await insertRow(sellerId, uuid7(), false, { market_id: 'bad' })).toBe('23514');
      expect(await insertRow(sellerId, uuid7(), false, { tenant_id: 'BAD' })).toBe('23514');
      expect(await insertRow(uuid7(), uuid7(), false)).toBe('23503');
      // The composite key ties the row to the seller's own Market.
      expect(
        await insertRow(sellerId, uuid7(), false, {
          market_id: other.marketId,
          tenant_id: other.tenantId,
        }),
      ).toBe('23503');
    });

    it('checks the change log: reason, extras and Market', async () => {
      const sellerId = await insertSeller();
      const insertChange = (overrides: Record<string, unknown> = {}) => {
        const row = {
          id: uuid7(),
          market_id: market.marketId,
          tenant_id: market.tenantId,
          seller_id: sellerId,
          changed_by: uuid7(),
          changed_at: T0.toString(),
          reason: 'why',
          before_main_id: null,
          before_extra_ids: [],
          after_main_id: uuid7(),
          after_extra_ids: [],
          ...overrides,
        };
        const columns = Object.keys(row);
        return sqlState(
          sql,
          `INSERT INTO sellers.seller_business_activity_changes (${columns.join(', ')})
           VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        );
      };
      expect(await insertChange()).toBeNull();
      expect(await insertChange({ reason: '' })).toBe('23514');
      expect(await insertChange({ reason: ' padded ' })).toBe('23514');
      expect(await insertChange({ reason: 'x'.repeat(301) })).toBe('23514');
      expect(await insertChange({ reason: 'x'.repeat(300) })).toBeNull();
      expect(await insertChange({ after_extra_ids: Array.from({ length: 10 }, uuid7) })).toBe(
        '23514',
      );
      expect(await insertChange({ before_extra_ids: Array.from({ length: 10 }, uuid7) })).toBe(
        '23514',
      );
      expect(await insertChange({ after_extra_ids: null })).toBe('23514');
      expect(await insertChange({ market_id: 'bad' })).toBe('23514');
      expect(await insertChange({ tenant_id: 'BAD' })).toBe('23514');
      expect(await insertChange({ seller_id: uuid7() })).toBe('23503');
    });

    it('grants the application role least privilege: replace by delete and insert, an insert-only log', async () => {
      const sellerId = await insertSeller();
      const activityId = uuid7();
      expect(await insertRow(sellerId, activityId, true)).toBeNull();
      expect(
        await sqlState(
          sql,
          'UPDATE sellers.seller_business_activities SET is_main = false WHERE seller_id = $1',
          [sellerId],
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          sql,
          'DELETE FROM sellers.seller_business_activities WHERE seller_id = $1 AND activity_id = $2',
          [sellerId, activityId],
        ),
      ).toBeNull();

      await inUnit(() =>
        repository.appendChange(market, {
          id: uuid7() as Id<'SellerActivityChange'>,
          sellerId,
          by: uuid7() as Id<'Account'>,
          at: T0,
          reason: 'why',
          before: { mainActivityId: null, extraActivityIds: [] },
          after: { mainActivityId: activityId as Id<'BusinessActivity'>, extraActivityIds: [] },
        }),
      );
      expect(
        await sqlState(
          sql,
          "UPDATE sellers.seller_business_activity_changes SET reason = 'changed' WHERE seller_id = $1",
          [sellerId],
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          sql,
          'DELETE FROM sellers.seller_business_activity_changes WHERE seller_id = $1',
          [sellerId],
        ),
      ).toBe('42501');
      expect(await sqlState(sql, 'TRUNCATE sellers.seller_business_activity_changes', [])).toBe(
        '42501',
      );
    });
  },
);
