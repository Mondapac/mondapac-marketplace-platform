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
  /** Every SECURITY DEFINER function (`schema.name(arguments)`), with why it is one. */
  readonly securityDefinerFunctions: Readonly<Record<string, string>>;
}

export const EXPECTED_PRIVILEGES: ExpectedPrivileges = {
  schemas: {
    platform: ['USAGE'],
  },
  tables: {
    'platform.audit_log': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'public._prisma_migrations': { table: [], columnUpdate: [] },
  },
  securityDefinerFunctions: {},
};
