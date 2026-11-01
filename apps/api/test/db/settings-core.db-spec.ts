import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { ChangeMarketSetting } from '../../src/modules/settings/application/use-cases/change-market-setting.use-case';
import { ReadListPaging } from '../../src/modules/settings/application/use-cases/read-list-paging.use-case';
import { ViewMarketSettings } from '../../src/modules/settings/application/use-cases/view-market-settings.use-case';
import type { SettingsDependencies } from '../../src/modules/settings/application/settings-dependencies';
import { PrismaMarketSettingRepository } from '../../src/modules/settings/infrastructure/prisma-market-setting.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The settings store as the application role in both Market fixtures: the tables' own guards (the
// primary keys, the CHECKs, the insert-only history, no delete, column-level grants) and the use
// cases on the real store: a change with its history row, two admins saving from the same
// version, and one Market never reading another's value.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';

describe.each(TEST_MARKETS)('settings in market %s (database)', (code) => {
  const market = marketOf(code);
  const clock = new FixedClock(Temporal.Instant.from('2020-03-02T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const admin = (name: string) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      name,
    );
  const seller = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: ids.next<'Seller'>(),
    }),
    'settings-db-seller-1',
  );

  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let deps: SettingsDependencies;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    deps = {
      unitOfWork: db.unitOfWork,
      settings: new PrismaMarketSettingRepository(db.service),
      audit: { record: () => Promise.resolve() },
      clock,
    };
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });
  // The tables refuse deletes (that is what is tested below), so the test clears its own Market's
  // rows with the guards switched off for the moment, as the owner.
  beforeEach(async () => {
    for (const [table, trigger] of [
      ['market_settings', 'market_settings_no_delete'],
      ['market_setting_history', 'market_setting_history_no_delete'],
    ] as const) {
      await owner.query(`ALTER TABLE settings.${table} DISABLE TRIGGER ${trigger}`);
      await owner.query(`DELETE FROM settings.${table} WHERE market_id = $1`, [market.marketId]);
      await owner.query(`ALTER TABLE settings.${table} ENABLE TRIGGER ${trigger}`);
    }
  });

  const code_ = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  const insert = (over: Record<string, unknown> = {}) => {
    const v = {
      market_id: market.marketId,
      tenant_id: 'default',
      code: 'list-paging',
      value: 'prev-next',
      version: 1,
      updated_at: new Date(),
      updated_by_account_id: ids.next<'Account'>(),
      ...over,
    };
    const keys = Object.keys(v);
    return sql.query(
      `INSERT INTO settings.market_settings (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(v),
    );
  };

  describe('tables', () => {
    it('refuses a bad market id, tenant id, code, value and version', async () => {
      expect(await code_(insert({ market_id: 'a' }))).toBe(CHECK);
      expect(await code_(insert({ tenant_id: 'Bad Tenant' }))).toBe(CHECK);
      expect(await code_(insert({ code: 'Bad Code' }))).toBe(CHECK);
      expect(await code_(insert({ value: '' }))).toBe(CHECK);
      expect(await code_(insert({ version: 0 }))).toBe(CHECK);
    });

    it('keeps one row per Market and code', async () => {
      expect(await code_(insert())).toBe('allowed');
      expect(await code_(insert())).toBe(UNIQUE);
    });

    it('lets the application change only the value, version and stamps, and never delete', async () => {
      await insert();
      expect(
        await code_(
          sql.query(
            `UPDATE settings.market_settings SET value = 'pages', version = 2, updated_at = now() WHERE market_id = $1`,
            [market.marketId],
          ),
        ),
      ).toBe('allowed');
      expect(
        await code_(
          sql.query(`UPDATE settings.market_settings SET code = 'x-y' WHERE market_id = $1`, [
            market.marketId,
          ]),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await code_(
          sql.query('DELETE FROM settings.market_settings WHERE market_id = $1', [market.marketId]),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(await code_(owner.query('DELETE FROM settings.market_settings'))).toBe(RESTRICT);
    });

    it('keeps the history insert-only', async () => {
      const row = [
        market.marketId,
        'default',
        'list-paging',
        1,
        null,
        'prev-next',
        new Date(),
        ids.next<'Account'>(),
      ];
      const text = `INSERT INTO settings.market_setting_history (market_id, tenant_id, code, version, previous_value, value, changed_at, changed_by_account_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
      expect(await code_(sql.query(text, row))).toBe('allowed');
      expect(await code_(sql.query(text, row))).toBe(UNIQUE);
      expect(
        await code_(sql.query(`UPDATE settings.market_setting_history SET value = 'pages'`)),
      ).toBe(NO_PRIVILEGE);
      expect(await code_(sql.query('DELETE FROM settings.market_setting_history'))).toBe(
        NO_PRIVILEGE,
      );
      expect(
        await code_(owner.query(`UPDATE settings.market_setting_history SET value = 'pages'`)),
      ).toBe(RESTRICT);
      expect(await code_(owner.query('DELETE FROM settings.market_setting_history'))).toBe(
        RESTRICT,
      );
      expect(await code_(owner.query('TRUNCATE settings.market_setting_history'))).toBe(RESTRICT);
    });
  });

  describe('use cases on the real store', () => {
    it('answers the default, then the changed value, with a history row', async () => {
      const read = () => new ReadListPaging(gate, deps).execute(seller, {});
      const first = await read();
      expect(first.ok && first.value).toBe('pages');
      const ctx = admin('settings-db-admin-1');
      const changed = await new ChangeMarketSetting(gate, deps).execute(ctx, {
        code: 'list-paging',
        value: 'prev-next',
        expectedVersion: 0,
      });
      expect(changed.ok && changed.value.version).toBe(1);
      const after = await read();
      expect(after.ok && after.value).toBe('prev-next');
      const view = await new ViewMarketSettings(gate, deps).execute(ctx, {});
      expect(view.ok && view.value[0]).toMatchObject({ value: 'prev-next', version: 1 });
      const history = await owner.query(
        'SELECT version, previous_value, value FROM settings.market_setting_history WHERE market_id = $1 AND code = $2 ORDER BY version',
        [market.marketId, 'list-paging'],
      );
      expect(history.rows.at(-1)).toMatchObject({
        version: 1,
        previous_value: null,
        value: 'prev-next',
      });
    });

    it('lets only one of two admins who saved from the same version win', async () => {
      const change = (name: string, value: string, expectedVersion: number) =>
        new ChangeMarketSetting(gate, deps).execute(admin(name), {
          code: 'list-paging',
          value,
          expectedVersion,
        });
      expect((await change('settings-db-seed-1', 'prev-next', 0)).ok).toBe(true);
      const race = await Promise.all([
        change('settings-db-a-1', 'pages', 1),
        change('settings-db-b-1', 'pages', 1),
      ]);
      expect(race.filter((r) => r.ok)).toHaveLength(1);
      expect(race.flatMap((r) => (r.ok ? [] : [r.error.code]))).toEqual(['settings.conflict']);
      const stored = await owner.query(
        'SELECT version, value FROM settings.market_settings WHERE market_id = $1',
        [market.marketId],
      );
      expect(stored.rows).toEqual([{ version: 2, value: 'pages' }]);
      const history = await owner.query(
        'SELECT version FROM settings.market_setting_history WHERE market_id = $1 ORDER BY version',
        [market.marketId],
      );
      expect(history.rows.map((row: { version: number }) => row.version)).toEqual([1, 2]);
    });
  });
});
