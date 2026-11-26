import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { migrationDatabaseUrl, REPO_ROOT } from './test-database';

// AI Gateway G4d2 (docs/design/domain/platform-ai.md sections 7 and 10): migration
// 20261126030000_ai_gateway_buyer_chat_caps, run against fixtures in a database of its own. Every
// migration before it is applied, both Market fixtures get assistant settings versions and buyer
// chat day counters, then the migration runs: a customised Market's caps become the gateway's
// settings (rows and history), a Market on the defaults gets no row, and the capability month
// counters are filled from the day rows. It runs again, down and up again, adding nothing twice.

const MIGRATIONS = join(REPO_ROOT, 'prisma', 'migrations');
const MIGRATION = '20261126030000_ai_gateway_buyer_chat_caps';
const CAPABILITY = 'assistant.buyer-chat';
const ADMIN = '0193a000-0000-7000-8000-000000000001';
const LATER_ADMIN = '0193a000-0000-7000-8000-000000000002';

/**
 * The statements of a migration file. One query with several statements runs in an implicit
 * transaction, which `CREATE INDEX CONCURRENTLY` refuses; Prisma sends them one by one. Splits at
 * semicolons outside quotes, comments and dollar-quoted bodies.
 */
function statementsOf(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== c) j += 1;
      i = j + 1;
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))?.[0];
      if (tag === undefined) i += 1;
      else {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
      }
    } else if (c === ';') {
      out.push(sql.slice(start, i + 1));
      start = i + 1;
      i += 1;
    } else i += 1;
  }
  out.push(sql.slice(start));
  return out.filter((statement) => statement.replace(/--.*$/gm, '').trim() !== '');
}

async function apply(client: Client, sql: string) {
  if (/CONCURRENTLY/i.test(sql)) {
    for (const statement of statementsOf(sql)) await client.query(statement);
  } else await client.query(sql);
}

describe('AI Gateway buyer chat caps migration (database integration, G4d2)', () => {
  const name = `g4d2mig_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: Client;
  let owner: Client;
  const [first, second] = TEST_MARKETS as readonly [string, string];
  const up = () => owner.query(readFileSync(join(MIGRATIONS, MIGRATION, 'migration.sql'), 'utf8'));
  const down = () => owner.query(readFileSync(join(MIGRATIONS, MIGRATION, 'down.sql'), 'utf8'));

  /** One assistant settings version: the caps in cents, and who saved it when. */
  const assistantVersion = (
    market: string,
    version: number,
    daily: number,
    monthly: number,
    by: string,
    at: string,
  ) =>
    owner.query(
      `INSERT INTO assistant.settings (market_id, version, tenant_id, enabled, audience,
         audience_percent, scope, model_tier, users, guest_message_limit, customer_message_limit,
         retention, reply_language, daily_spend_cap_usd_cents, monthly_spend_cap_usd_cents,
         support_handoff, basket_proposals, welcome_text, changed_at, changed_by)
       VALUES ($1, $2, 'mondapac', true, 'all', NULL, 'read-only', 'fast', 'guests-and-customers',
               20, 40, '30-days', 'buyer', $3, $4, 'email-link', false, NULL, $6, $5)`,
      [market, version, daily, monthly, by, at],
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: migrationDatabaseUrl() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "mondapac_app"`);
    const ownerUrl = new URL(migrationDatabaseUrl());
    ownerUrl.pathname = `/${name}`;
    owner = new Client({ connectionString: ownerUrl.toString() });
    await owner.connect();

    const folders = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toContain(MIGRATION);
    await owner.query(
      'CREATE TABLE public._prisma_migrations (migration_name TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL)',
    );
    for (const folder of folders.filter((folder) => folder < MIGRATION)) {
      await owner.query(
        'INSERT INTO public._prisma_migrations (migration_name, started_at) VALUES ($1, now())',
        [folder],
      );
      await apply(owner, readFileSync(join(MIGRATIONS, folder, 'migration.sql'), 'utf8'));
    }

    // The first Market customised both caps, then saved them again lower: the latest version wins.
    await assistantVersion(first, 1, 2000, 30000, ADMIN, '2026-11-01T00:00:00Z');
    await assistantVersion(first, 2, 500, 15000, LATER_ADMIN, '2026-11-10T00:00:00Z');
    // The second Market saved other settings but kept the default caps: no row for it.
    await assistantVersion(second, 1, 1000, 20000, ADMIN, '2026-11-02T00:00:00Z');

    // Buyer chat and description writer day counters over two months, and other scopes the
    // backfill leaves alone.
    await owner.query(
      `INSERT INTO platform.ai_budget_counters (market_id, tenant_id, period, period_start, scope,
         scope_key, held_micro_usd, spent_micro_usd)
       VALUES ($1, 'mondapac', 'day', '2026-10-31', 'capability', $3, 700, 700),
              ($1, 'mondapac', 'day', '2026-11-01', 'capability', $3, 1000, 900),
              ($1, 'mondapac', 'day', '2026-11-25', 'capability', $3, 2500, 2000),
              ($1, 'mondapac', 'day', '2026-11-25', 'capability', 'catalog.description-writer', 50, 50),
              ($1, 'mondapac', 'day', '2026-11-25', 'market', '', 3550, 2950),
              ($1, 'mondapac', 'month', '2026-11-01', 'market', '', 3550, 2950),
              ($2, 'mondapac', 'day', '2026-11-25', 'capability', $3, 300, 300)`,
      [first, second, CAPABILITY],
    );
    await up();
  });

  afterAll(async () => {
    await (owner as Client | undefined)?.end();
    await (admin as Client | undefined)?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await (admin as Client | undefined)?.end();
  });

  const settingRows = async () =>
    (
      await owner.query<Record<string, unknown>>(
        `SELECT market_id, code, value, version, updated_by_account_id::text AS by,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS at
           FROM settings.market_settings ORDER BY market_id, code`,
      )
    ).rows;
  const historyRows = async () =>
    (
      await owner.query<Record<string, unknown>>(
        `SELECT market_id, code, version, previous_value, value, note,
                changed_by_account_id::text AS by
           FROM settings.market_setting_history ORDER BY market_id, code, version`,
      )
    ).rows;
  const monthCounters = async () =>
    (
      await owner.query<Record<string, unknown>>(
        `SELECT concat_ws('|', market_id, period_start::text, scope_key) AS key,
                held_micro_usd::text AS held, spent_micro_usd::text AS spent
           FROM platform.ai_budget_counters
          WHERE scope = 'capability' AND period = 'month' ORDER BY key`,
      )
    ).rows;

  it("copies a customised Market's latest caps as micro-dollars, with the admin who set them", async () => {
    await expect(settingRows()).resolves.toEqual([
      {
        market_id: first,
        code: 'ai-cap-buyer-chat-day',
        value: '5000000',
        version: 1,
        by: LATER_ADMIN,
        at: '2026-11-10',
      },
      {
        market_id: first,
        code: 'ai-cap-buyer-chat-month',
        value: '150000000',
        version: 1,
        by: LATER_ADMIN,
        at: '2026-11-10',
      },
    ]);
    await expect(historyRows()).resolves.toEqual([
      {
        market_id: first,
        code: 'ai-cap-buyer-chat-day',
        version: 1,
        previous_value: null,
        value: '5000000',
        note: null,
        by: LATER_ADMIN,
      },
      {
        market_id: first,
        code: 'ai-cap-buyer-chat-month',
        version: 1,
        previous_value: null,
        value: '150000000',
        note: null,
        by: LATER_ADMIN,
      },
    ]);
  });

  it('fills each capability month counter from its day rows, in the month of the Market day', async () => {
    await expect(monthCounters()).resolves.toEqual([
      { key: `${first}|2026-10-01|${CAPABILITY}`, held: '700', spent: '700' },
      { key: `${first}|2026-11-01|${CAPABILITY}`, held: '3500', spent: '2900' },
      { key: `${first}|2026-11-01|catalog.description-writer`, held: '50', spent: '50' },
      { key: `${second}|2026-11-01|${CAPABILITY}`, held: '300', spent: '300' },
    ]);
    const reservations = await owner.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'ai_budget_reservations'
          AND column_name = 'capability_month'`,
    );
    expect(reservations.rows).toEqual([{ column_default: 'false' }]);
  });

  it('adds nothing twice when it runs again after a failure part way', async () => {
    const before = {
      settings: await settingRows(),
      history: await historyRows(),
      counters: await monthCounters(),
    };
    await up();
    expect(await settingRows()).toEqual(before.settings);
    expect(await historyRows()).toEqual(before.history);
    expect(await monthCounters()).toEqual(before.counters);
  });

  it('reverts to the state before it (down), and up again gives the same rows', async () => {
    const before = {
      settings: await settingRows(),
      history: await historyRows(),
      counters: await monthCounters(),
    };
    await down();
    expect(await settingRows()).toEqual([]);
    expect(await historyRows()).toEqual([]);
    expect(await monthCounters()).toEqual([]);
    const column = await owner.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'ai_budget_reservations'
          AND column_name = 'capability_month'`,
    );
    expect(column.rows).toEqual([]);
    await up();
    expect(await settingRows()).toEqual(before.settings);
    expect(await historyRows()).toEqual(before.history);
    expect(await monthCounters()).toEqual(before.counters);
    // The down switched the insert-only triggers on again.
    await expect(owner.query('DELETE FROM settings.market_settings')).rejects.toMatchObject({
      code: '23001',
    });
    await expect(owner.query('DELETE FROM settings.market_setting_history')).rejects.toMatchObject({
      code: '23001',
    });
  });
});
