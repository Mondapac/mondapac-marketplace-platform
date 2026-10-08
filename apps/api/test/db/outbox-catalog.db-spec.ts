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
  'certification.issuers_market_id_type_id_accreditation_number_key':
    'CREATE UNIQUE INDEX issuers_market_id_type_id_accreditation_number_key ON certification.issuers USING btree (market_id, type_id, accreditation_number) WHERE (accreditation_number IS NOT NULL)',
  'certification.outbox_market_id_event_id_unpublished_idx':
    'CREATE INDEX outbox_market_id_event_id_unpublished_idx ON certification.outbox USING btree (market_id, event_id) WHERE (published_at IS NULL)',
  'certification.seller_certifications_market_id_approved_boundary_at_idx':
    "CREATE INDEX seller_certifications_market_id_approved_boundary_at_idx ON certification.seller_certifications USING btree (market_id, approved_boundary_at) WHERE (status = 'approved'::text)",
  'certification.seller_certifications_market_id_seller_id_type_id_open_key':
    "CREATE UNIQUE INDEX seller_certifications_market_id_seller_id_type_id_open_key ON certification.seller_certifications USING btree (market_id, seller_id, type_id) WHERE (status <> ALL (ARRAY['declined'::text, 'revoked'::text]))",
  'identity.accounts_market_id_signed_up_at_unverified_idx':
    'CREATE INDEX accounts_market_id_signed_up_at_unverified_idx ON identity.accounts USING btree (market_id, signed_up_at) WHERE (email_verified_at IS NULL)',
  'identity.invitations_market_id_email_pending_platform_key':
    "CREATE UNIQUE INDEX invitations_market_id_email_pending_platform_key ON identity.invitations USING btree (market_id, email_normalized) WHERE ((state = 'pending'::text) AND (seller_id IS NULL))",
  'identity.invitations_market_id_seller_id_email_pending_key':
    "CREATE UNIQUE INDEX invitations_market_id_seller_id_email_pending_key ON identity.invitations USING btree (market_id, seller_id, email_normalized) WHERE ((state = 'pending'::text) AND (seller_id IS NOT NULL))",
  'identity.invitations_market_id_seller_id_owner_pending_key':
    "CREATE UNIQUE INDEX invitations_market_id_seller_id_owner_pending_key ON identity.invitations USING btree (market_id, seller_id) WHERE ((kind = 'seller-owner'::text) AND (state = 'pending'::text))",
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
  // docs/design/data/pricing.md 3.1 and 3.3: the relay's claim, one pending regular record per
  // series, and the partial GiST index behind the no-overlap exclusion constraint (below).
  'pricing.outbox_market_id_event_id_unpublished_idx':
    'CREATE INDEX outbox_market_id_event_id_unpublished_idx ON pricing.outbox USING btree (market_id, event_id) WHERE (published_at IS NULL)',
  'pricing.regular_price_records_effective_period_excl':
    "CREATE INDEX regular_price_records_effective_period_excl ON pricing.regular_price_records USING gist (market_id, series_id, tstzrange(effective_from, effective_to, '[)'::text)) WHERE (status = ANY (ARRAY['accepted'::text, 'approved'::text]))",
  'pricing.regular_price_records_market_id_series_id_pending_key':
    "CREATE UNIQUE INDEX regular_price_records_market_id_series_id_pending_key ON pricing.regular_price_records USING btree (market_id, series_id) WHERE (status = 'pending-review'::text)",
  'sellers.outbox_market_id_event_id_unpublished_idx':
    'CREATE INDEX outbox_market_id_event_id_unpublished_idx ON sellers.outbox USING btree (market_id, event_id) WHERE (published_at IS NULL)',
  'sellers.seller_files_market_id_identifier_index_idx':
    'CREATE INDEX seller_files_market_id_identifier_index_idx ON sellers.seller_files USING btree (market_id, identifier_index) WHERE (identifier_index IS NOT NULL)',
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

  it('has exactly the checked-in exclusion constraints (Prisma does not model them)', async () => {
    const { rows } = await sql.query<{ name: string; definition: string }>(
      `SELECT n.nspname || '.' || c.conname AS name, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'x' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_%'
        ORDER BY 1`,
    );

    // docs/design/data/sellers.md 3.7 and 9.5: no two periods of one seller overlap.
    // docs/design/data/pricing.md 3.3 (PD1): no two effective regular periods of a series overlap.
    expect(Object.fromEntries(rows.map((row) => [row.name, row.definition]))).toEqual({
      'pricing.regular_price_records_effective_period_excl':
        "EXCLUDE USING gist (market_id WITH =, series_id WITH =, tstzrange(effective_from, effective_to, '[)'::text) WITH &&) WHERE ((status = ANY (ARRAY['accepted'::text, 'approved'::text])))",
      'sellers.tax_registration_periods_no_overlap_excl':
        "EXCLUDE USING gist (market_id WITH =, seller_id WITH =, tstzrange(valid_from, valid_to, '[)'::text) WITH &&)",
    });
  });
});
