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
  'catalog.outbox_market_id_event_id_unpublished_idx':
    'CREATE INDEX outbox_market_id_event_id_unpublished_idx ON catalog.outbox USING btree (market_id, event_id) WHERE (published_at IS NULL)',
  'catalog.product_variants_market_id_product_id_single_key':
    "CREATE UNIQUE INDEX product_variants_market_id_product_id_single_key ON catalog.product_variants USING btree (market_id, product_id) WHERE (variant_model = 'single'::text)",
  'catalog.products_market_id_owner_seller_id_created_at_idx':
    'CREATE INDEX products_market_id_owner_seller_id_created_at_idx ON catalog.products USING btree (market_id, owner_seller_id, created_at, id) WHERE (owner_seller_id IS NOT NULL)',
  'catalog.products_market_id_pending_submitted_at_idx':
    'CREATE INDEX products_market_id_pending_submitted_at_idx ON catalog.products USING btree (market_id, pending_submitted_at, id) WHERE (pending_revision_id IS NOT NULL)',
  'catalog.products_market_id_published_revision_id_key':
    'CREATE UNIQUE INDEX products_market_id_published_revision_id_key ON catalog.products USING btree (market_id, published_revision_id) WHERE (published_revision_id IS NOT NULL)',
  'identity.accounts_market_id_signed_up_at_unverified_idx':
    'CREATE INDEX accounts_market_id_signed_up_at_unverified_idx ON identity.accounts USING btree (market_id, signed_up_at) WHERE (email_verified_at IS NULL)',
  'identity.outbox_market_id_event_id_unpublished_idx':
    'CREATE INDEX outbox_market_id_event_id_unpublished_idx ON identity.outbox USING btree (market_id, event_id) WHERE (published_at IS NULL)',
  'identity.roles_market_id_name_platform_custom_key':
    "CREATE UNIQUE INDEX roles_market_id_name_platform_custom_key ON identity.roles USING btree (market_id, name_normalized) WHERE ((kind = 'custom'::text) AND (scope = 'platform'::text))",
  'identity.roles_market_id_scope_system_key':
    "CREATE UNIQUE INDEX roles_market_id_scope_system_key ON identity.roles USING btree (market_id, scope) WHERE (kind = 'system'::text)",
  'identity.roles_market_id_seller_id_name_custom_key':
    "CREATE UNIQUE INDEX roles_market_id_seller_id_name_custom_key ON identity.roles USING btree (market_id, seller_id, name_normalized) WHERE ((kind = 'custom'::text) AND (seller_id IS NOT NULL))",
  'identity.seller_memberships_market_id_account_id_active_key':
    "CREATE UNIQUE INDEX seller_memberships_market_id_account_id_active_key ON identity.seller_memberships USING btree (market_id, account_id) WHERE (state = 'active'::text)",
  'identity.sessions_market_id_seller_id_seller_idx':
    'CREATE INDEX sessions_market_id_seller_id_seller_idx ON identity.sessions USING btree (market_id, seller_id) WHERE (seller_id IS NOT NULL)',
  'inventory.sources_market_id_seller_id_default_key':
    'CREATE UNIQUE INDEX sources_market_id_seller_id_default_key ON inventory.sources USING btree (market_id, seller_id) WHERE is_default',
  'sellers.outbox_market_id_event_id_unpublished_idx':
    'CREATE INDEX outbox_market_id_event_id_unpublished_idx ON sellers.outbox USING btree (market_id, event_id) WHERE (published_at IS NULL)',
  'sellers.shop_slugs_market_id_seller_id_held_key':
    "CREATE UNIQUE INDEX shop_slugs_market_id_seller_id_held_key ON sellers.shop_slugs USING btree (market_id, seller_id) WHERE (state = 'held'::text)",
  'platform.event_delivery_market_id_next_attempt_at_pending_idx':
    "CREATE INDEX event_delivery_market_id_next_attempt_at_pending_idx ON platform.event_delivery USING btree (market_id, next_attempt_at) WHERE (status = 'pending'::text)",
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
