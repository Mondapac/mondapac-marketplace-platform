import { parseSql } from './pg-parser';
import { checkStatement, type StatementOwner } from './statement-check';

// The parse check of ADR-0030 decisions 3 to 5 with the real parser (Hassan I-1, Sajad's
// loader smoke test): what passes, and one case per rule it must refuse.

const owner: StatementOwner = {
  schema: 'certification',
  tables: new Set(['certification_types', 'seller_certifications', 'issuers']),
};

const GOOD = `
SELECT q.ord, t.id AS type_id, c.status, i.state
  FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS q(seller_id, type_code, ord)
  JOIN "certification"."certification_types" t ON t.market_id = $1 AND t.code = q.type_code
  JOIN "certification"."seller_certifications" c
    ON c.market_id = $1 AND c.seller_id = q.seller_id AND c.type_id = t.id
   AND c.status NOT IN ('declined', 'revoked')
  LEFT JOIN "certification"."issuers" i ON i.market_id = $1 AND i.type_id = t.id`;

const check = (sql: string, params: readonly unknown[] = [{}, {}]): Promise<string[]> =>
  checkStatement(parseSql, { id: 'certification.test', sql, params }, owner);

describe('the parser loads and reads PostgreSQL 17', () => {
  it('answers PostgreSQL 17, rejects a syntax error and sees stacked statements', async () => {
    const parsed = await parseSql('select 1; select 2');
    expect((parsed as { version: number }).version).toBe(170007);
    expect(parsed.stmts).toHaveLength(2);
    await expect(parseSql('selec 1')).rejects.toThrow(/syntax error/);
  });
});

describe('raw read statement check', () => {
  it('passes a listed-style statement (unnest, joins, literals, own schema)', async () => {
    expect(await check(GOOD)).toEqual([]);
  });

  it('passes a root table with the Market in WHERE, a CTE and a set operation', async () => {
    expect(
      await check(
        `WITH w AS (SELECT t.id FROM "certification"."certification_types" t WHERE t.market_id = $1)
         SELECT w.id FROM w
         UNION ALL
         SELECT i.id FROM "certification"."issuers" i WHERE i.market_id = $1 AND i.type_id = ANY($2::uuid[])`,
        [{}],
      ),
    ).toEqual([]);
  });

  it.each([
    ['stacked statements', 'SELECT 1; SELECT 2', 'not-one-statement'],
    ['an insert', 'INSERT INTO "certification"."issuers" (id) VALUES ($1)', 'not-a-select'],
    ['a syntax error', 'SELEC 1', 'parse-failed'],
  ])('refuses %s', async (_name, sql, violation) => {
    expect(await check(sql, [])).toEqual([violation]);
  });

  it('refuses a data-modifying CTE', async () => {
    const result = await check(
      `WITH d AS (DELETE FROM "certification"."issuers" i WHERE i.market_id = $1 RETURNING i.id)
       SELECT d.id FROM d`,
      [],
    );
    expect(result).toEqual(expect.arrayContaining(['data-modifying-cte']));
  });

  it.each([
    ['FOR UPDATE', 'locking-clause', `${GOOD} FOR UPDATE OF t`],
    ['FOR SHARE', 'locking-clause', `${GOOD} FOR SHARE`],
    [
      'SELECT INTO',
      'select-into',
      `SELECT t.id INTO TEMP x FROM "certification"."certification_types" t WHERE t.market_id = $1`,
    ],
  ])('refuses %s', async (_name, violation, sql) => {
    expect(await check(sql, [{}, {}])).toContain(violation);
  });

  it.each([
    [
      'another module schema',
      'relation-schema:sellers.seller_files',
      `SELECT 1 FROM "sellers"."seller_files" s WHERE s.market_id = $1`,
    ],
    ['public', 'relation-schema:public.x', `SELECT 1 FROM "public"."x" s WHERE s.market_id = $1`],
    [
      'a system catalog',
      'relation-schema:pg_catalog.pg_class',
      `SELECT 1 FROM pg_catalog.pg_class s WHERE s.market_id = $1`,
    ],
    [
      'an unqualified table',
      'relation-unqualified:issuers',
      `SELECT 1 FROM issuers s WHERE s.market_id = $1`,
    ],
    [
      'a table that is not an owner model (a view)',
      'relation-not-owner-table:v_issuers',
      `SELECT 1 FROM "certification"."v_issuers" s WHERE s.market_id = $1`,
    ],
  ])('refuses %s', async (_name, violation, sql) => {
    expect(await check(sql, [])).toContain(violation);
  });

  it.each([
    [
      'now()',
      'function-not-allowed:now',
      `SELECT now() FROM "certification"."issuers" i WHERE i.market_id = $1`,
    ],
    [
      'nextval',
      'function-not-allowed:nextval',
      `SELECT nextval('s') FROM "certification"."issuers" i WHERE i.market_id = $1`,
    ],
    [
      'set_config',
      'function-not-allowed:set_config',
      `SELECT set_config('a','b',false) FROM "certification"."issuers" i WHERE i.market_id = $1`,
    ],
    [
      'an aggregate',
      'function-not-allowed:count',
      `SELECT count(*) FROM "certification"."issuers" i WHERE i.market_id = $1`,
    ],
    [
      'a set-returning function in FROM',
      'function-not-allowed:generate_series',
      `SELECT g FROM generate_series(1, 3) g`,
    ],
    [
      'a user schema function',
      'function-not-allowed:certification.f',
      `SELECT certification.f($2) FROM "certification"."issuers" i WHERE i.market_id = $1`,
    ],
  ])('refuses %s', async (_name, violation, sql) => {
    expect(await check(sql, [{}])).toContain(violation);
  });

  it('allows pg_catalog.unnest but only over bound parameters', async () => {
    expect(
      await check(
        `SELECT u FROM pg_catalog.unnest($2::uuid[]) AS u, "certification"."issuers" i WHERE i.market_id = $1`,
        [{}],
      ),
    ).toEqual([]);
    expect(
      await check(
        `SELECT u FROM unnest(ARRAY['a','b']) AS u, "certification"."issuers" i WHERE i.market_id = $1`,
        [],
      ),
    ).toContain('unnest-argument-not-param');
  });

  it.each([
    [
      'no Market predicate on a join',
      `SELECT 1 FROM "certification"."issuers" i JOIN "certification"."certification_types" t ON t.id = i.type_id WHERE i.market_id = $1`,
      'market-rule:t',
    ],
    [
      'the Market only in WHERE for a joined table',
      `SELECT 1 FROM "certification"."issuers" i JOIN "certification"."certification_types" t ON t.id = i.type_id WHERE i.market_id = $1 AND t.market_id = $1`,
      'market-rule:t',
    ],
    [
      'the Market inside an OR',
      `SELECT 1 FROM "certification"."issuers" i WHERE i.market_id = $1 OR i.id = $2`,
      'market-rule:i',
    ],
    [
      'no Market predicate at all',
      `SELECT 1 FROM "certification"."issuers" i WHERE i.id = $1`,
      'market-rule:i',
    ],
    [
      'the Market of another alias',
      `SELECT 1 FROM "certification"."issuers" i WHERE x.market_id = $1`,
      'market-rule:i',
    ],
    [
      'USING instead of ON',
      `SELECT 1 FROM "certification"."issuers" i JOIN "certification"."certification_types" t USING (id) WHERE i.market_id = $1`,
      'market-rule:t',
    ],
    [
      'the Market inside a subquery missing',
      `SELECT 1 FROM "certification"."issuers" i WHERE i.market_id = $1 AND EXISTS (SELECT 1 FROM "certification"."certification_types" t WHERE t.id = i.type_id)`,
      'market-rule:t',
    ],
  ])('refuses %s', async (_name, sql, violation) => {
    expect(await check(sql, [])).toContain(violation);
  });

  it('refuses the Market compared with a literal, an expression or another parameter', async () => {
    expect(
      await check(
        `SELECT 1 FROM "certification"."issuers" i WHERE i.market_id = $1 AND i.market_id = 'AU'`,
        [],
      ),
    ).toContain('market-literal');
    expect(
      await check(
        `SELECT 1 FROM "certification"."issuers" i WHERE i.market_id = $1 AND i.market_id = lower($2)`,
        [{}],
      ),
    ).toContain('market-compared-to-expression');
    expect(
      await check(
        `SELECT 1 FROM "certification"."issuers" i WHERE i.market_id = $1 AND i.market_id = $2`,
        [{}],
      ),
    ).toContain('market-compared-to-other-param');
  });

  it('refuses parameters that do not match the declaration', async () => {
    const sql = `SELECT 1 FROM "certification"."issuers" i WHERE i.market_id = $1 AND i.id = ANY($2::uuid[])`;
    expect(await check(sql, [])).toContain('param-undeclared:$2');
    expect(await check(sql, [{}, {}])).toContain('param-unused:$3');
    expect(
      await check(`SELECT 1 FROM "certification"."issuers" i WHERE i.id = $2`, [{}]),
    ).toContain('market-parameter-missing');
  });

  it('fails closed when the parser throws', async () => {
    const result = await checkStatement(
      () => Promise.reject(new Error('WASM module not initialized')),
      { id: 'certification.test', sql: GOOD, params: [{}, {}] },
      owner,
    );
    expect(result).toEqual(['parse-failed']);
  });

  it('refuses a recursive CTE', async () => {
    const result = await check(
      `WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n FROM r) SELECT n FROM r, "certification"."issuers" i WHERE i.market_id = $1`,
      [],
    );
    expect(result).toContain('recursive-cte');
  });
});
