import type { Client } from 'pg';

/**
 * Mojtaba's catalog check of ADR-0030 decision 9: `EXPLAIN (GENERIC_PLAN)` of the text (the
 * parameters stay `$n`), and every relation the plan reads is an ordinary or partitioned table
 * (`relkind` r or p), never a view, a foreign table or a catalog relation. Returns the problems
 * (empty when sound).
 */
export async function explainCatalogProblems(client: Client, sql: string): Promise<string[]> {
  const plan = await client.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) ${sql}`,
  );
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      if (typeof record['Relation Name'] === 'string') {
        names.add(`${String(record['Schema'])}.${record['Relation Name']}`);
      }
      Object.values(record).forEach(walk);
    }
  };
  walk(plan.rows[0]?.['QUERY PLAN']);
  const problems: string[] = [];
  if (names.size === 0) problems.push('plan-reads-no-relation');
  for (const name of names) {
    const [schema, relation] = name.split('.');
    const found = await client.query<{ relkind: string }>(
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, relation],
    );
    if (found.rows[0] === undefined || !['r', 'p'].includes(found.rows[0].relkind)) {
      problems.push(`relation-not-a-table:${name}`);
    }
  }
  return problems;
}

/**
 * Runs the text with the given parameters inside `BEGIN READ ONLY` and rolls back (Hassan C1):
 * the database itself refuses a data-modifying CTE, a locking clause and `nextval`.
 */
export async function runReadOnly(
  client: Client,
  sql: string,
  values: unknown[],
): Promise<unknown[]> {
  await client.query('BEGIN READ ONLY');
  try {
    const result: { rows: unknown[] } = await client.query(sql, values);
    return result.rows;
  } finally {
    await client.query('ROLLBACK');
  }
}
