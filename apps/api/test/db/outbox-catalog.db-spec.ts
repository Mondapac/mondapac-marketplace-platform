import { Client } from 'pg';
import { modelMap } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Catalog checks of the migrated database (platform persistence design 13, row "Catalog";
// docs/design/data/identity.md 8.4, option A5). Every `outbox` table has the same columns, in
// the same order, with the same types and nullability (PM1); every module outbox of the model
// map exists. The partial indexes, invisible to Prisma's drift check, are exactly the
// checked-in list below. `pg_catalog`, not `information_schema`, so the role does not matter.

/**
 * Every partial index the migrations create, by `schema.index`, with its definition as
 * PostgreSQL prints it. A migration that adds, drops or changes one changes this list.
 */
const PARTIAL_INDEXES: Readonly<Record<string, string>> = {
  'identity.accounts_market_id_signed_up_at_unverified_idx':
    'CREATE INDEX accounts_market_id_signed_up_at_unverified_idx ON identity.accounts USING btree (market_id, signed_up_at) WHERE (email_verified_at IS NULL)',
  'identity.outbox_market_id_event_id_unpublished_idx':
    'CREATE INDEX outbox_market_id_event_id_unpublished_idx ON identity.outbox USING btree (market_id, event_id) WHERE (published_at IS NULL)',
};

const OUTBOX_COLUMNS = `
SELECT n.nspname AS schema,
       string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) ||
                  CASE WHEN a.attnotnull THEN ' not null' ELSE '' END ||
                  CASE WHEN a.atthasdef THEN ' default' ELSE '' END,
                  ', ' ORDER BY a.attnum) AS columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relkind = 'r' AND c.relname = 'outbox'
 GROUP BY n.nspname
 ORDER BY 1`;

const PARTIAL_INDEX_DEFINITIONS = `
SELECT n.nspname || '.' || ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = ic.relnamespace
 WHERE i.indpred IS NOT NULL
   AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
 ORDER BY 1`;

describe('outbox tables and partial indexes (database catalog)', () => {
  let sql: Client;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
  });

  it('has an outbox table for every module outbox of the model map, and no other', async () => {
    const { rows } = await sql.query<{ schema: string }>(OUTBOX_COLUMNS);
    const expected = Object.values(modelMap.modules)
      .filter((module) => module.outboxModel !== null)
      .map((module) => modelMap.models[module.outboxModel!]!.schema)
      .sort();

    expect(rows.map((row) => row.schema)).toEqual(expected);
    expect(expected).toContain('identity');
  });

  it('gives every outbox table the same columns: the envelope, published_at, no default', async () => {
    const { rows } = await sql.query<{ schema: string; columns: string }>(OUTBOX_COLUMNS);

    for (const row of rows) {
      expect({ [row.schema]: row.columns }).toEqual({
        [row.schema]:
          'event_id uuid not null, type text not null, ' +
          'occurred_at timestamp(6) with time zone not null, ' +
          'market_id character varying(8) not null, tenant_id text not null, ' +
          'aggregate_type text not null, aggregate_id uuid not null, ' +
          'aggregate_version integer not null, correlation_id text not null, ' +
          'causation_id uuid, payload jsonb not null, ' +
          'published_at timestamp(6) with time zone',
      });
    }
  });

  it('has exactly the checked-in partial indexes', async () => {
    const { rows } = await sql.query<{ name: string; definition: string }>(
      PARTIAL_INDEX_DEFINITIONS,
    );

    expect(Object.fromEntries(rows.map((row) => [row.name, row.definition]))).toEqual(
      PARTIAL_INDEXES,
    );
  });
});
