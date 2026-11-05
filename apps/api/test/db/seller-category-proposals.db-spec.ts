import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaCategoryProposalsSettingRepository } from '../../src/modules/sellers/infrastructure/prisma-category-proposals-setting.repository';
import { PrismaSellingFactsRepository } from '../../src/modules/sellers/infrastructure/prisma-selling-facts.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The category-proposals switch of a seller (SEL-26; categories C9-0) on PostgreSQL, for both
// Market fixtures: the read behind `mayProposeCategories`, the lock that raises the settings row's
// version, the set with who and when, and Market isolation, as the application role. Sellers are
// inserted as the application role and removed as the owner at the end.

const T0 = Temporal.Instant.from('2026-11-05T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('seller category proposals switch in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const created: string[] = [];
  let persistence: Persistence;
  let setting: PrismaCategoryProposalsSettingRepository;
  let facts: PrismaSellingFactsRepository;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    persistence = createPersistence();
    setting = new PrismaCategoryProposalsSettingRepository(persistence.service);
    facts = new PrismaSellingFactsRepository(persistence.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await Promise.all([sql.connect(), owner.connect()]);
  });
  afterAll(async () => {
    for (const sellerId of created) {
      for (const table of ['seller_admin_settings', 'seller_files']) {
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

  /** A seller file with its settings row (proposals off), in the given Market. */
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

  it('reads off for a new seller, locks with a version bump and sets who and when', async () => {
    const sellerId = await insertSeller();
    const by = uuid7() as Id<'Account'>;
    expect(await inUnit(() => facts.categoryProposalsAllowed(market, sellerId))).toBe(false);

    const state = await inUnit(async () => {
      const locked = await setting.lock(market, sellerId);
      await setting.set(market, sellerId, { allowed: true, by, at: T0 });
      return locked;
    });
    expect(state).toEqual({ allowed: false, version: 2 });
    expect(await inUnit(() => facts.categoryProposalsAllowed(market, sellerId))).toBe(true);

    const row = await sql.query<{
      category_proposals_allowed: boolean;
      category_proposals_changed_at: Date;
      category_proposals_changed_by_account_id: string;
      version: number;
    }>(
      `SELECT category_proposals_allowed, category_proposals_changed_at,
              category_proposals_changed_by_account_id, version
         FROM sellers.seller_admin_settings WHERE seller_id = $1`,
      [sellerId],
    );
    expect(row.rows[0]).toEqual({
      category_proposals_allowed: true,
      category_proposals_changed_at: new Date(T0.epochMilliseconds),
      category_proposals_changed_by_account_id: by,
      version: 2,
    });

    const again = await inUnit(() => setting.lock(market, sellerId));
    expect(again).toEqual({ allowed: true, version: 3 });
  });

  it("treats an unknown seller and another Market's seller alike: null, nothing written", async () => {
    const elsewhere = await insertSeller(other);
    const unknown = uuid7() as Id<'Seller'>;
    for (const sellerId of [elsewhere, unknown]) {
      expect(await inUnit(() => facts.categoryProposalsAllowed(market, sellerId))).toBeNull();
      expect(await inUnit(() => setting.lock(market, sellerId))).toBeNull();
    }
    const row = await sql.query<{ version: number }>(
      'SELECT version FROM sellers.seller_admin_settings WHERE seller_id = $1',
      [elsewhere],
    );
    expect(row.rows[0]?.version).toBe(1);
    expect(await inUnitOf(other)(() => facts.categoryProposalsAllowed(other, elsewhere))).toBe(
      false,
    );
  });
});
