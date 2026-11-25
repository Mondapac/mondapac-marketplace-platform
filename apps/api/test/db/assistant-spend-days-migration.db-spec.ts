import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { migrationDatabaseUrl, REPO_ROOT } from './test-database';

// AI Gateway G7, step 1 (docs/design/domain/platform-ai.md section 10): the backfill of migration
// 20261125150000_assistant_spend_days_expand, run against fixtures in a database of its own. Every
// migration before it is applied, assistant.spend_days and part of the gateway's counting are
// filled in both Market fixtures, then the migration runs; its down and up again add nothing twice.

const MIGRATIONS = join(REPO_ROOT, 'prisma', 'migrations');
const EXPAND = '20261125150000_assistant_spend_days_expand';
const CAPABILITY = 'assistant.buyer-chat';

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

describe('assistant spend_days expand migration (database integration, AI Gateway G7)', () => {
  const name = `g7mig_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: Client;
  let owner: Client;
  const [first, second] = TEST_MARKETS as readonly [string, string];

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
    expect(folders).toContain(EXPAND);
    // The history Prisma keeps: a later migration reads when an earlier one started.
    await owner.query(
      'CREATE TABLE public._prisma_migrations (migration_name TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL)',
    );
    for (const folder of folders.filter((folder) => folder < EXPAND)) {
      await owner.query(
        'INSERT INTO public._prisma_migrations (migration_name, started_at) VALUES ($1, now())',
        [folder],
      );
      await apply(owner, readFileSync(join(MIGRATIONS, folder, 'migration.sql'), 'utf8'));
    }

    // spend_days: (Market, day, spend, input, output, conversations, auto-off cap, auto-off at).
    const days: [string, string, number, number, number, number, string | null, string | null][] = [
      [first, '2026-11-20', 5000, 100, 50, 3, null, null],
      [first, '2026-11-25', 9000, 200, 80, 4, 'daily', '2026-11-25T03:00:00Z'],
      [first, '2026-10-31', 400, 8, 4, 0, null, null],
      [second, '2026-11-25', 700, 10, 5, 1, 'monthly', '2026-11-25T10:00:00Z'],
    ];
    for (const row of days) {
      await owner.query(
        `INSERT INTO assistant.spend_days (market_id, day, tenant_id, spend_micro_usd, input_tokens,
           output_tokens, conversations, auto_off_cap, auto_off_at)
         VALUES ($1, $2, 'mondapac', $3, $4, $5, $6, $7, $8)`,
        row,
      );
    }
    // The gateway counted part of the first Market's 25 Nov already (G2 went live that day), and a
    // seller capability's row the backfill must leave alone.
    await owner.query(
      `INSERT INTO platform.ai_usage_days (id, market_id, tenant_id, day, capability, seller_id, calls,
         input_tokens, output_tokens, cost_micro_usd)
       VALUES (gen_random_uuid(), $1, 'mondapac', '2026-11-25', $2, NULL, 2, 150, 60, 6000),
              (gen_random_uuid(), $1, 'mondapac', '2026-11-25', 'catalog.description-writer',
               gen_random_uuid(), 1, 10, 10, 111)`,
      [first, CAPABILITY],
    );
    await owner.query(
      `INSERT INTO platform.ai_budget_counters (market_id, tenant_id, period, period_start, scope,
         scope_key, held_micro_usd, spent_micro_usd)
       VALUES ($1, 'mondapac', 'day', '2026-11-25', 'capability', $2, 6500, 6000),
              ($1, 'mondapac', 'day', '2026-11-25', 'market', '', 6611, 6111),
              ($1, 'mondapac', 'month', '2026-11-01', 'market', '', 6611, 6111)`,
      [first, CAPABILITY],
    );
    await owner.query(readFileSync(join(MIGRATIONS, EXPAND, 'migration.sql'), 'utf8'));
  });

  afterAll(async () => {
    await (owner as Client | undefined)?.end();
    await (admin as Client | undefined)?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await (admin as Client | undefined)?.end();
  });

  const conversationDays = async () =>
    (
      await owner.query<{ market_id: string; day: string; conversations: number }>(
        `SELECT market_id, day::text AS day, conversations FROM assistant.conversation_days
          ORDER BY market_id, day`,
      )
    ).rows;
  const usageDays = async () =>
    (
      await owner.query<{
        market_id: string;
        day: string;
        cost: string;
        input: string;
        output: string;
        calls: number;
      }>(
        `SELECT market_id, day::text AS day, cost_micro_usd::text AS cost,
                input_tokens::text AS input, output_tokens::text AS output, calls
           FROM platform.ai_usage_days WHERE capability = $1 ORDER BY market_id, day`,
        [CAPABILITY],
      )
    ).rows;
  const counters = async () =>
    (
      await owner.query<{
        key: string;
        held: string;
        spent: string;
        reached_at: string | null;
        reached: string | null;
      }>(
        `SELECT concat_ws('|', market_id, period, period_start::text, scope, scope_key) AS key,
                held_micro_usd::text AS held, spent_micro_usd::text AS spent,
                to_char(cap_reached_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reached_at,
                cap_reached_period AS reached
           FROM platform.ai_budget_counters ORDER BY key`,
      )
    ).rows;

  it('copies the conversation counts of days that had any', async () => {
    await expect(conversationDays()).resolves.toEqual(
      [
        { market_id: first, day: '2026-11-20', conversations: 3 },
        { market_id: first, day: '2026-11-25', conversations: 4 },
        { market_id: second, day: '2026-11-25', conversations: 1 },
      ].sort((a, b) => `${a.market_id}${a.day}`.localeCompare(`${b.market_id}${b.day}`)),
    );
  });

  it('adds to the gateway day rows only the spend the gateway did not count', async () => {
    const rows = await usageDays();
    const byKey = new Map(rows.map((row) => [`${row.market_id}|${row.day}`, row]));
    expect(byKey.get(`${first}|2026-11-20`)).toMatchObject({
      cost: '5000',
      input: '100',
      output: '50',
      calls: 0,
    });
    // 9000 in spend_days, 6000 counted by the gateway: 3000 added; the calls stay the gateway's.
    expect(byKey.get(`${first}|2026-11-25`)).toMatchObject({
      cost: '9000',
      input: '200',
      output: '80',
      calls: 2,
    });
    expect(byKey.get(`${first}|2026-10-31`)).toMatchObject({ cost: '400' });
    expect(byKey.get(`${second}|2026-11-25`)).toMatchObject({ cost: '700' });
    expect(rows).toHaveLength(4);
  });

  it('adds the same spend to the capability, Market day and Market month counters', async () => {
    const rows = new Map((await counters()).map((row) => [row.key, row]));
    const held = (key: string) => [rows.get(key)?.held, rows.get(key)?.spent];
    expect(held(`${first}|day|2026-11-25|capability|${CAPABILITY}`)).toEqual(['9500', '9000']);
    expect(held(`${first}|day|2026-11-25|market|`)).toEqual(['9611', '9111']);
    expect(held(`${first}|day|2026-11-20|capability|${CAPABILITY}`)).toEqual(['5000', '5000']);
    expect(held(`${first}|month|2026-11-01|market|`)).toEqual(['14611', '14111']);
    expect(held(`${first}|month|2026-10-01|market|`)).toEqual(['400', '400']);
    expect(held(`${second}|month|2026-11-01|market|`)).toEqual(['700', '700']);
  });

  it('moves each auto-off record to the capability day counter', async () => {
    const reached = (await counters())
      .filter((row) => row.reached_at !== null)
      .map((row) => ({ key: row.key, at: row.reached_at, period: row.reached }));
    // Ordered by key: the first Market fixture (AU) before the second (ZZ).
    expect(reached).toEqual([
      {
        key: `${first}|day|2026-11-25|capability|${CAPABILITY}`,
        at: '2026-11-25T03:00:00Z',
        period: 'day',
      },
      {
        key: `${second}|day|2026-11-25|capability|${CAPABILITY}`,
        at: '2026-11-25T10:00:00Z',
        period: 'month',
      },
    ]);
  });

  it('refuses a cap-reached record on any row but a capability day', async () => {
    await expect(
      owner.query(
        `UPDATE platform.ai_budget_counters SET cap_reached_at = now(), cap_reached_period = 'day'
          WHERE market_id = $1 AND scope = 'market' AND period = 'day'`,
        [first],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(
        `UPDATE platform.ai_budget_counters SET cap_reached_at = now()
          WHERE market_id = $1 AND scope = 'capability' AND period_start = '2026-11-20'`,
        [first],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('adds nothing twice when it is reverted and applied again', async () => {
    const before = { usage: await usageDays(), counters: await counters() };
    await owner.query(readFileSync(join(MIGRATIONS, EXPAND, 'down.sql'), 'utf8'));
    await owner.query(readFileSync(join(MIGRATIONS, EXPAND, 'migration.sql'), 'utf8'));
    expect(await usageDays()).toEqual(before.usage);
    expect(await counters()).toEqual(before.counters);
  });
});
