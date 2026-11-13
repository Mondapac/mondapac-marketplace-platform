import { Logger } from '@nestjs/common';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { ChangeAiAccessUseCase } from '../../src/modules/sellers/application/use-cases/change-ai-access.use-case';
import { ViewAiAccessUseCase } from '../../src/modules/sellers/application/use-cases/view-ai-access.use-case';
import { PrismaAiAccessSettingRepository } from '../../src/modules/sellers/infrastructure/prisma-ai-access-setting.repository';
import { PrismaSellingFactsRepository } from '../../src/modules/sellers/infrastructure/prisma-selling-facts.repository';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { SystemClock } from '../../src/platform/clock/system-clock';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The per-seller AI switch (SEL-25; ADR-0019 decision 7) on PostgreSQL, for both Market fixtures:
// the read behind `aiAccessOf`, the lock that raises the settings row's version, the set with who
// and when, the admin read, Market isolation, the use case with its audit row and no outbox row,
// and two admins switching at once, as the application role. Sellers are inserted as the
// application role and removed as the owner at the end.

const T0 = Temporal.Instant.from('2026-11-05T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('seller AI switch in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const created: string[] = [];
  let persistence: Persistence;
  let setting: PrismaAiAccessSettingRepository;
  let facts: PrismaSellingFactsRepository;
  let change: ChangeAiAccessUseCase;
  let view: ViewAiAccessUseCase;
  let audits: AuditEntry[];
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    persistence = createPersistence();
    setting = new PrismaAiAccessSettingRepository(persistence.service);
    facts = new PrismaSellingFactsRepository(persistence.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await Promise.all([sql.connect(), owner.connect()]);
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
    change = new ChangeAiAccessUseCase(gate, {
      unitOfWork: persistence.unitOfWork,
      aiAccessSetting: setting,
      audit,
      clock: new SystemClock(),
    });
    view = new ViewAiAccessUseCase(gate, {
      unitOfWork: persistence.unitOfWork,
      aiAccessSetting: setting,
    });
  });
  afterAll(async () => {
    for (const sellerId of created) {
      for (const table of ['seller_admin_settings', 'seller_files']) {
        await owner.query(`DELETE FROM sellers.${table} WHERE seller_id = $1`, [sellerId]);
      }
    }
    await Promise.all([sql.end(), owner.end(), persistence.close()]);
    jest.restoreAllMocks();
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

  /** A seller file with its settings row (AI off), in the given Market. */
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

  it('reads off for a new seller, locks with a version bump and sets who and when', async () => {
    const sellerId = await insertSeller();
    const by = uuid7() as Id<'Account'>;
    expect(await inUnit(() => facts.aiEnabled(market, sellerId))).toBe(false);
    expect(await inUnit(() => setting.read(market, sellerId))).toEqual({
      enabled: false,
      changedAt: null,
    });

    const state = await inUnit(async () => {
      const locked = await setting.lock(market, sellerId);
      await setting.set(market, sellerId, { enabled: true, by, at: T0 });
      return locked;
    });
    expect(state).toEqual({ enabled: false, version: 2 });
    expect(await inUnit(() => facts.aiEnabled(market, sellerId))).toBe(true);
    expect(await inUnit(() => setting.read(market, sellerId))).toEqual({
      enabled: true,
      changedAt: T0,
    });

    const row = await sql.query(
      `SELECT ai_enabled, ai_enabled_changed_at, ai_enabled_changed_by_account_id,
              category_proposals_allowed, version
         FROM sellers.seller_admin_settings WHERE seller_id = $1`,
      [sellerId],
    );
    expect(row.rows[0]).toEqual({
      ai_enabled: true,
      ai_enabled_changed_at: new Date(T0.epochMilliseconds),
      ai_enabled_changed_by_account_id: by,
      category_proposals_allowed: false,
      version: 2,
    });
    expect(await inUnit(() => setting.lock(market, sellerId))).toEqual({
      enabled: true,
      version: 3,
    });
  });

  it("treats an unknown seller and another Market's seller alike: null, nothing written", async () => {
    const elsewhere = await insertSeller(other);
    const unknown = uuid7() as Id<'Seller'>;
    for (const sellerId of [elsewhere, unknown]) {
      expect(await inUnit(() => facts.aiEnabled(market, sellerId))).toBeNull();
      expect(await inUnit(() => setting.read(market, sellerId))).toBeNull();
      expect(await inUnit(() => setting.lock(market, sellerId))).toBeNull();
      expect(await view.execute(admin(), { sellerId })).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
      expect(await change.execute(admin(), { sellerId, body: { enabled: true } })).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
    }
    const row = await sql.query<{ version: number; ai_enabled: boolean }>(
      'SELECT version, ai_enabled FROM sellers.seller_admin_settings WHERE seller_id = $1',
      [elsewhere],
    );
    expect(row.rows[0]).toEqual({ version: 1, ai_enabled: false });
  });

  it('changes through the use case with one audit row, no outbox row and a repeat that is unchanged', async () => {
    const sellerId = await insertSeller();
    audits.length = 0;
    expect(await change.execute(admin(), { sellerId, body: { enabled: true } })).toEqual({
      ok: true,
      value: { enabled: true, changed: true },
    });
    expect(await change.execute(admin(), { sellerId, body: { enabled: true } })).toEqual({
      ok: true,
      value: { enabled: true, changed: false },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'sellers.ai-access.changed',
      before: { enabled: false },
      after: { enabled: true },
    });
    const shown = await view.execute(admin(), { sellerId });
    expect(shown.ok && shown.value.enabled).toBe(true);
    expect(shown.ok && shown.value.changedAt).not.toBeNull();
    const outbox = await sql.query(`SELECT 1 FROM sellers.outbox WHERE payload->>'sellerId' = $1`, [
      sellerId,
    ]);
    expect(outbox.rowCount).toBe(0);
  });

  it('lets one of two concurrent switches change the value: the other is unchanged', async () => {
    const sellerId = await insertSeller();
    const results = await Promise.all([
      change.execute(admin(), { sellerId, body: { enabled: true } }),
      change.execute(admin(), { sellerId, body: { enabled: true } }),
    ]);
    const changed = results.map((result) => (result.ok ? result.value.changed : null)).sort();
    expect(changed).toEqual([false, true]);
  });
});
