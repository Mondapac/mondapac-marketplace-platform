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
  | 'audit_log_privilege'
  | 'role_timeouts';

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

/** The connected role's own settings (`ALTER ROLE ... SET`), as `name=value` entries. */
export const ROLE_CONFIG_SQL = `
SELECT r.rolconfig FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/**
 * The ceiling of each timeout every application login must carry in its own settings
 * (10.7 role settings, K1a; 10.8 `role_timeouts`), in milliseconds.
 */
export const ROLE_TIMEOUT_CEILINGS_MS: Readonly<Record<string, number>> = Object.freeze({
  statement_timeout: 30_000,
  lock_timeout: 3_000,
  idle_in_transaction_session_timeout: 60_000,
});

/** PostgreSQL's time units for a setting whose base unit is the millisecond. */
const TIME_UNITS_MS: Readonly<Record<string, number>> = Object.freeze({
  us: 0.001,
  ms: 1,
  s: 1_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

/** A time setting in milliseconds (no unit means milliseconds), or null when unreadable. */
export function settingMilliseconds(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/.exec(value);
  if (match === null) return null;
  const factor = match[2] === '' ? 1 : TIME_UNITS_MS[match[2]!];
  return factor === undefined ? null : Number(match[1]) * factor;
}

/**
 * `role_timeouts` (10.8): each timeout of {@link ROLE_TIMEOUT_CEILINGS_MS} is present in the
 * role's own settings, above zero and at most its ceiling. Presence and ceiling only, not
 * equality. A database-level setting does not count, by design. An unreadable value fails.
 */
export function roleTimeoutProblems(rolconfig: readonly string[] | null): RoleProblem[] {
  const settings = new Map<string, string>();
  for (const entry of rolconfig ?? []) {
    const separator = entry.indexOf('=');
    if (separator > 0) settings.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return Object.entries(ROLE_TIMEOUT_CEILINGS_MS)
    .filter(([name, ceiling]) => {
      const value = settings.get(name);
      const ms = value === undefined ? null : settingMilliseconds(value);
      return ms === null || ms <= 0 || ms > ceiling;
    })
    .map(([name]) => ({ code: 'role_timeouts' as const, subject: name }));
}

/** One row of the start-up queries, as any client returns it. */
type QueryRow = Readonly<Record<string, unknown>>;

/**
 * Runs {@link ROLE_PROBLEMS_SQL} and {@link ROLE_CONFIG_SQL} through any client; an error
 * while running them propagates. The `role_timeouts` problems come last.
 */
export async function findRoleProblems(
  query: (sql: string) => Promise<readonly QueryRow[]>,
): Promise<RoleProblem[]> {
  const rows = await query(ROLE_PROBLEMS_SQL);
  const problems = rows.map((row) => ({
    code: row.code as RoleProblemCode,
    subject: (row.subject as string | null) ?? null,
  }));
  const config = await query(ROLE_CONFIG_SQL);
  const rolconfig = (config[0]?.rolconfig as readonly string[] | null | undefined) ?? null;
  return [...problems, ...roleTimeoutProblems(rolconfig)];
}
