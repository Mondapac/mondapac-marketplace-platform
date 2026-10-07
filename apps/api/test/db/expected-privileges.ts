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
    platform: ['USAGE'],
  },
  tables: {
    // docs/design/data/identity.md section 7: DELETE only for the unverified purge and erasure
    // (A2, H5); the credential goes with its account by the cascade, so it has no DELETE.
    'identity.accounts': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.password_credentials': {
      table: ['INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/identity.md section 7 (PM2): the envelope is immutable to the application.
    'identity.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'platform.audit_log': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/identity.md section 7 (PF 4): a tombstone, no DELETE; the identity
    // columns are frozen by the trigger as well.
    'platform.subject_keys': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['wrapped_key', 'wrapping_key_id', 'rewrapped_at', 'destroyed_at'],
    },
    'public._prisma_migrations': { table: [], columnUpdate: [] },
  },
  extensions: {
    // Exclusion constraints on `=` of ids (sellers tax registration periods; V2 records later).
    btree_gist: 'extensions',
  },
  securityDefinerFunctions: {},
};
