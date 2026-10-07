/**
 * The start-up self-check of the database role (docs/design/data/platform.md 10.8). The
 * application connects as a login in `mondapac_app` and nothing more; a mis-wired secret (the
 * migration URL, a superuser, an extra membership) must stop the process before it serves a
 * request. The tests run the same check as the owner (refused) and as the application (passes).
 */

/** Why the connected role was refused; stable codes, never the URL. */
export type RoleProblemCode =
  | 'session_role'
  | 'role_attribute'
  | 'role_membership'
  | 'owner_membership'
  | 'create_on_database'
  | 'create_on_schema'
  | 'temporary_on_database'
  | 'audit_log_privilege';

export interface RoleProblem {
  readonly code: RoleProblemCode;
  /** The role, schema or attribute concerned, where one applies. */
  readonly subject: string | null;
}

/** The one group role the application's login may belong to (10.1). */
export const APPLICATION_GROUP_ROLE = 'mondapac_app';

/** Schemas that are not PostgreSQL's own; `n` is `pg_namespace`. */
const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

/**
 * One row per problem; no row means the role is what the application may run as. Both the
 * session user and the current user are checked: a privileged login that switches to the
 * application role (`options=-c role=...`, `ALTER ROLE ... SET role`) could `SET ROLE` back.
 */
export const ROLE_PROBLEMS_SQL = `
SELECT 'session_role' AS code, session_user::text AS subject
 WHERE session_user <> current_user
UNION ALL
SELECT 'role_attribute', r.rolname || '.' || a.attribute
  FROM pg_catalog.pg_roles r
 CROSS JOIN LATERAL (VALUES ('rolsuper', r.rolsuper), ('rolcreaterole', r.rolcreaterole),
                            ('rolcreatedb', r.rolcreatedb), ('rolreplication', r.rolreplication),
                            ('rolbypassrls', r.rolbypassrls)) AS a (attribute, granted)
 WHERE r.rolname IN (current_user, session_user) AND a.granted
UNION ALL
SELECT 'role_membership', r.rolname
  FROM pg_catalog.pg_roles r
 WHERE r.rolname NOT IN (current_user, '${APPLICATION_GROUP_ROLE}')
   AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
UNION ALL
SELECT 'owner_membership', pg_catalog.pg_get_userbyid(owner)
  FROM (SELECT d.datdba AS owner FROM pg_catalog.pg_database d
         WHERE d.datname = pg_catalog.current_database()
        UNION
        SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE ${USER_SCHEMA}
        UNION
        SELECT c.relowner FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMA}
        UNION
        SELECT p.proowner FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE ${USER_SCHEMA}
       ) AS owners
 WHERE pg_catalog.pg_has_role(current_user, owner, 'MEMBER')
UNION ALL
SELECT 'create_on_database', NULL
 WHERE pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE')
UNION ALL
SELECT 'create_on_schema', n.nspname
  FROM pg_catalog.pg_namespace n
 WHERE pg_catalog.has_schema_privilege(n.oid, 'CREATE')
UNION ALL
SELECT 'temporary_on_database', NULL
 WHERE pg_catalog.has_database_privilege(pg_catalog.current_database(), 'TEMPORARY')
UNION ALL
SELECT 'audit_log_privilege', NULL
  FROM (SELECT pg_catalog.to_regclass('platform.audit_log') AS audit_log) AS t
 WHERE t.audit_log IS NOT NULL
   AND (pg_catalog.has_table_privilege(t.audit_log, 'UPDATE, DELETE, TRUNCATE, TRIGGER')
        OR pg_catalog.has_any_column_privilege(t.audit_log, 'UPDATE')
        -- MAINTAIN (PostgreSQL 17) allows LOCK TABLE, which could block audit writes.
        OR CASE WHEN pg_catalog.current_setting('server_version_num')::int >= 170000
                THEN pg_catalog.has_table_privilege(t.audit_log, 'MAINTAIN')
                ELSE false END)
ORDER BY 1, 2`;

/** Runs {@link ROLE_PROBLEMS_SQL} through any client; an error while running it propagates. */
export async function findRoleProblems(
  query: (sql: string) => Promise<readonly { code: string; subject: string | null }[]>,
): Promise<RoleProblem[]> {
  const rows = await query(ROLE_PROBLEMS_SQL);
  return rows.map((row) => ({ code: row.code as RoleProblemCode, subject: row.subject }));
}
