/**
 * Every privilege a migration grants, checked in (docs/design/data/platform.md 10.2 and 10.5
 * guard 1). `privileges.db-spec.ts` compares the catalogs of the migrated database with this
 * map; a migration that grants, revokes or adds a table changes this file in the same PR.
 * The only grantee is the group role `mondapac_app`; the owner's own privileges are not listed.
 */
export interface ExpectedPrivileges {
  /** Schema-level privileges of `mondapac_app`, by schema. */
  readonly schemas: Readonly<Record<string, readonly string[]>>;
  /**
   * Every table of every schema that is not PostgreSQL's own, with the table-level privileges
   * of `mondapac_app` and the columns it may UPDATE when it has no table-level UPDATE.
   */
  readonly tables: Readonly<
    Record<string, { readonly table: readonly string[]; readonly columnUpdate: readonly string[] }>
  >;
  /**
   * Extensions the migrations install, each with its schema. A member function of a mapped
   * extension may be executable by PUBLIC (its owner is a superuser, so the migration role
   * cannot revoke that) only while the schema stays closed to the application: no `USAGE`, no
   * `CREATE` for anyone but its owner, and on nobody's `search_path` (platform.md 10.5 guard 1,
   * docs/design/data/sellers.md 9.2 and 9.6). Never `public`.
   */
  readonly extensions: Readonly<Record<string, string>>;
  /** Every SECURITY DEFINER function (`schema.name(arguments)`), with why it is one. */
  readonly securityDefinerFunctions: Readonly<Record<string, string>>;
}

export const EXPECTED_PRIVILEGES: ExpectedPrivileges = {
  schemas: {
    // No privilege for the application on `extensions` (see `extensions` below).
    extensions: [],
    identity: ['USAGE'],
    inventory: ['USAGE'],
    platform: ['USAGE'],
    catalog: ['USAGE'],
    sellers: ['USAGE'],
  },
  tables: {
    // docs/design/data/identity.md section 7: DELETE only for the unverified purge and erasure
    // (A2, H5); the credential goes with its account by the cascade, so it has no DELETE.
    'identity.accounts': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.password_credentials': {
      table: ['INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/identity.md section 7 (slice 2): sessions and throttle counters are
    // ordinary tables (revocation, the last_seen_at write, the purge, a cleared counter); sign-in
    // records are append-only with retention, so no UPDATE (H6).
    'identity.sessions': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.sign_in_records': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'identity.sign_in_throttles': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/identity.md section 7 (PM2): the envelope is immutable to the application.
    'identity.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // docs/design/data/identity.md section 7 (slice 3): a link row is reused per account and
    // purpose and purged when consumed or expired; the inbox gets DELETE with its prune job.
    'identity.one_time_links': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/identity.md section 7 (slice 5): ordinary tables, except the keys of a
    // role, which are added or removed and never edited.
    'identity.seller_access': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.seller_memberships': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.roles': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.role_permissions': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'identity.role_assignments': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'platform.audit_log': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/identity.md section 7 (slice 3; PM3): the envelope copy is immutable to
    // the application; DELETE arrives with the prune job.
    'platform.event_delivery': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'attempts',
        'dead_at',
        'delivered_at',
        'error_code',
        'next_attempt_at',
        'status',
      ],
    },
    // docs/design/data/identity.md section 7 (PF 4): a tombstone, no DELETE; the identity
    // columns are frozen by the trigger as well.
    'platform.subject_keys': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['wrapped_key', 'wrapping_key_id', 'rewrapped_at', 'destroyed_at'],
    },
    // docs/design/data/sellers.md section 8 (slice 1): the outbox is immutable to the application
    // but for the relay's mark; the inbox gets DELETE with the prune job; the four roots have no
    // DELETE until the purge of slice 18.
    'sellers.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'sellers.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'sellers.seller_files': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'sellers.seller_admin_settings': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'sellers.seller_tax_profiles': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'sellers.store_profiles': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    // docs/design/data/sellers.md section 8 (slice 2): a slug and its holder never change, only
    // its state (DELETE arrives in slice 5, Q-M21); rate counters are reserved, released (the
    // two reviewer-notice kinds, 3.11) and purged after 48 hours.
    'sellers.shop_slugs': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['ever_public', 'retired_at', 'state', 'version'],
    },
    'sellers.rate_counters': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    // docs/design/data/inventory.md section 7 (slice 1): the inbox gets DELETE with the prune job;
    // a seller inventory is never deleted and a source has no delete in the brief; the seller,
    // the key columns and the Default flag are immutable, so UPDATE is by column.
    'inventory.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'inventory.seller_inventories': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['low_stock_threshold', 'version'],
    },
    'inventory.sources': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['address', 'name', 'priority', 'time_zone'],
    },
    // docs/design/data/catalog.md section 7 (slice 1): the outbox is immutable to the application
    // but for the relay's mark; no DELETE on products or variants, ever (Q-K2: a discard is a
    // status and a retired variant). The identity columns of a product and a variant never change.
    'catalog.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'catalog.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.products': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'discarded_at',
        'last_changed_at',
        'matched_into_product_id',
        'owner_seller_id',
        'own_brand',
        'promoted_at',
        'retired_at',
        'scope',
        'status',
        'version',
        'withdrawn_at',
      ],
    },
    'catalog.product_variants': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['published_at', 'retired_at', 'state'],
    },
    'catalog.product_code_counters': { table: ['INSERT', 'SELECT'], columnUpdate: ['next_value'] },
    'public._prisma_migrations': { table: [], columnUpdate: [] },
  },
  extensions: {
    // Exclusion constraints on `=` of ids (sellers tax registration periods; V2 records later).
    btree_gist: 'extensions',
  },
  securityDefinerFunctions: {},
};
