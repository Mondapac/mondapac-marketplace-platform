import { Logger } from '@nestjs/common';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { BlogAccessSetUseCase } from '../../src/modules/sellers/application/use-cases/blog-access-set.use-case';
import { ChangeCategoryProposalsUseCase } from '../../src/modules/sellers/application/use-cases/change-category-proposals.use-case';
import { SELLERS_EVENTS } from '../../src/modules/sellers/domain/events';
import { PrismaBlogAccessRepository } from '../../src/modules/sellers/infrastructure/prisma-blog-access.repository';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { SystemClock } from '../../src/platform/clock/system-clock';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PrismaCategoryProposalsSettingRepository } from '../../src/modules/sellers/infrastructure/prisma-category-proposals-setting.repository';
import { PrismaSellingFactsRepository } from '../../src/modules/sellers/infrastructure/prisma-selling-facts.repository';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  modelMap,
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

// Hassan's review of C9-0 (L1): the whole use case on PostgreSQL with the real outbox, next to the
// blog switch on the same settings row, and two admins revoking at once.
describe.each(TEST_MARKETS)(
  'seller category proposals switch, use case on market %s (database)',
  (code) => {
    const market = marketOf(code);
    const created: string[] = [];
    let persistence: Persistence;
    let sql: Client;
    let owner: Client;
    let audits: AuditEntry[];
    let change: ChangeCategoryProposalsUseCase;
    let blog: BlogAccessSetUseCase;

    beforeAll(async () => {
      for (const level of ['log', 'warn', 'error'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
      }
      persistence = createPersistence();
      sql = new Client({ connectionString: testDatabaseUrl() });
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await Promise.all([sql.connect(), owner.connect()]);
      const catalogue = new EventCatalogue();
      catalogue.register('sellers', SELLERS_EVENTS);
      catalogue.seal();
      const clock = new SystemClock();
      const ids = new UuidV7IdGenerator(clock);
      const outbox = new PrismaOutboxWriterFactory(
        modelMap,
        persistence.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('sellers');
      audits = [];
      const audit: AuditWriter = {
        record: (_context, entry) => {
          audits.push(entry);
          return Promise.resolve();
        },
      };
      const gate = createUseCaseGate(
        new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
        { check: () => Promise.resolve({ allowed: true }) },
      );
      const unitOfWork = persistence.unitOfWork;
      change = new ChangeCategoryProposalsUseCase(gate, {
        unitOfWork,
        categoryProposalsSetting: new PrismaCategoryProposalsSettingRepository(persistence.service),
        audit,
        outbox,
        clock,
      });
      blog = new BlogAccessSetUseCase(gate, {
        unitOfWork,
        blogAccess: new PrismaBlogAccessRepository(persistence.service),
        audit,
        outbox,
        clock,
      });
    });
    afterAll(async () => {
      for (const sellerId of created) {
        await owner.query(`DELETE FROM sellers.outbox WHERE payload->>'sellerId' = $1`, [sellerId]);
        for (const table of ['seller_admin_settings', 'seller_files']) {
          await owner.query(`DELETE FROM sellers.${table} WHERE seller_id = $1`, [sellerId]);
        }
      }
      await Promise.all([sql.end(), owner.end(), persistence.close()]);
      jest.restoreAllMocks();
    });

    async function insertSeller(allowed: boolean): Promise<Id<'Seller'>> {
      const sellerId = uuid7();
      created.push(sellerId);
      await sql.query(
        `INSERT INTO sellers.seller_files
         (seller_id, market_id, tenant_id, origin, approval_required_at_registration,
          draft_complete, last_changed_at, version, created_at)
       VALUES ($1, $2, $3, 'self', true, false, now(), 1, now())`,
        [sellerId, market.marketId, market.tenantId],
      );
      await sql.query(
        `INSERT INTO sellers.seller_admin_settings
         (seller_id, market_id, tenant_id, all_product_types_allowed, category_proposals_allowed,
          ai_enabled, version, created_at)
       VALUES ($1, $2, $3, true, $4, false, 1, now())`,
        [sellerId, market.marketId, market.tenantId, allowed],
      );
      return sellerId as Id<'Seller'>;
    }

    const admin = () =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: null,
        }),
      );

    const outboxOf = (sellerId: string) =>
      sql
        .query<{ type: string; aggregate_id: string; aggregate_version: number }>(
          `SELECT type, aggregate_id, aggregate_version FROM sellers.outbox
          WHERE payload->>'sellerId' = $1 ORDER BY aggregate_version, type`,
          [sellerId],
        )
        .then((result) => result.rows);

    it('writes its own aggregate next to the blog switch on the same row, versions rising', async () => {
      const sellerId = await insertSeller(false);
      audits.length = 0;
      expect((await change.execute(admin(), { sellerId, body: { allowed: true } })).ok).toBe(true);
      expect((await blog.execute(admin(), { sellerId, body: { enabled: true } })).ok).toBe(true);
      expect((await change.execute(admin(), { sellerId, body: { allowed: false } })).ok).toBe(true);

      const rows = await outboxOf(sellerId);
      expect(rows.map((row) => row.type)).toEqual([
        'sellers.category-proposals-granted.v1',
        'sellers.blog-access-changed.v1',
        'sellers.category-proposals-revoked.v1',
      ]);
      const [granted, blogged, revoked] = rows;
      expect(granted!.aggregate_id).not.toBe(blogged!.aggregate_id);
      expect(revoked!.aggregate_id).toBe(granted!.aggregate_id);
      expect(granted!.aggregate_version).toBeLessThan(blogged!.aggregate_version);
      expect(blogged!.aggregate_version).toBeLessThan(revoked!.aggregate_version);
      expect(audits.map((entry) => entry.action)).toEqual([
        'sellers.category-proposals.changed',
        'sellers.blog-access.change',
        'sellers.category-proposals.changed',
      ]);
    });

    it('lets one of two concurrent revokes change the switch: one event, the other unchanged', async () => {
      const sellerId = await insertSeller(true);
      const results = await Promise.all([
        change.execute(admin(), { sellerId, body: { allowed: false } }),
        change.execute(admin(), { sellerId, body: { allowed: false } }),
      ]);
      const changed = results.map((result) => (result.ok ? result.value.changed : null)).sort();
      expect(changed).toEqual([false, true]);
      const rows = await outboxOf(sellerId);
      expect(rows.map((row) => row.type)).toEqual(['sellers.category-proposals-revoked.v1']);
    });
  },
);
