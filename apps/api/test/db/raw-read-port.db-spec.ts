import { randomUUID } from 'node:crypto';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaRawReadPort } from '../../src/platform/persistence/raw-reads/prisma-raw-read-port';
import {
  RAW_READ_STATEMENTS,
  type RawReadEntry,
} from '../../src/platform/persistence/raw-reads/statements';
import { NoUnitOfWorkError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  recordDriverStatements,
  type Persistence,
} from './persistence-support';
import { explainCatalogProblems, runReadOnly } from './raw-read-support';
import { testDatabaseUrl, ownerTestDatabaseUrl } from './test-database';

// ADR-0030 decision 9 for the port, on a test entry over certification's own table, and the
// same checks (BEGIN READ ONLY, catalog) for every checked-in entry as it is added. Both
// Market fixtures, as the application role.

const entry: RawReadEntry<{ id: string; code: string }> = {
  id: 'certification.test-types-by-code',
  owner: 'certification',
  reason: 'test entry of the port',
  design: 'ADR-0030 decision 9',
  sql: `SELECT t.id, t.code, q.ord
  FROM unnest($2::text[]) WITH ORDINALITY AS q(code, ord)
  JOIN "certification"."certification_types" t ON t.market_id = $1 AND t.code = q.code
 ORDER BY q.ord`,
  params: [{ name: 'codes', type: 'text[]', maxLength: 5 }],
  parseRow: (row) => {
    const { id, code } = row as { id: string; code: string };
    if (typeof id !== 'string' || typeof code !== 'string') throw new Error('row');
    return { id, code };
  },
};

const uuid7 = (): string => uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10)));
const CODE = `rawread-${randomUUID().slice(0, 8)}`;

describe('raw read port (database integration)', () => {
  let db: Persistence;
  let owner: Client;
  let app: Client;
  let port: PrismaRawReadPort;
  let driver: ReturnType<typeof recordDriverStatements>;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    driver = recordDriverStatements();
    db = createPersistence();
    port = new PrismaRawReadPort(db.root, [entry]);
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    app = new Client({ connectionString: testDatabaseUrl() });
    await owner.connect();
    await app.connect();
    // The same code in both Markets, each with its own row.
    for (const code of TEST_MARKETS) {
      const market = marketOf(code);
      const id = uuid7();
      ids.set(code, id);
      await owner.query(
        `INSERT INTO certification.certification_types
           (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
         VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', 'active', NULL, 1, now())`,
        [id, market.marketId, market.tenantId, CODE],
      );
    }
  });
  afterAll(async () => {
    driver.restore();
    await owner.end();
    await app.end();
    await db.close();
  });

  const call = (code: string, codes: string[], readOnly = true) =>
    db.unitOfWork.run(
      marketOf(code),
      async () => ({
        ok: true as const,
        value: await port.rawRead(marketOf(code), entry.id as never, { codes }),
      }),
      readOnly ? { readOnly: true } : {},
    );

  describe.each(TEST_MARKETS)('in a read-only unit of %s', (code) => {
    it('answers the rows of its own Market only, in the order of the zipped array', async () => {
      const result = await call(code, [CODE, 'no-such-code']);
      expect(result.ok && result.value).toEqual([{ id: ids.get(code), code: CODE }]);
      const other = await call(otherMarketOf(code), [CODE]);
      expect(other.ok && other.value).toEqual([{ id: ids.get(otherMarketOf(code)), code: CODE }]);
      expect(ids.get(code)).not.toBe(ids.get(otherMarketOf(code)));
    });

    it('issues exactly one SQL statement and no BEGIN', async () => {
      await driver.during(async () => {
        await call(code, [CODE]);
      });
      expect(driver.statements).toHaveLength(1);
      expect(driver.statements[0]).toContain('unnest($2::text[])');
      expect(driver.statements.join(' ')).not.toMatch(/BEGIN|COMMIT|SET TRANSACTION/i);
    });

    it('is refused in a read-write unit and outside any unit', async () => {
      await expect(call(code, [CODE], false)).rejects.toMatchObject({ reason: 'read-write-unit' });
      await expect(
        (port.rawRead as (m: unknown, i: string, p: unknown) => Promise<unknown>)(
          marketOf(code),
          entry.id,
          { codes: [] },
        ),
      ).rejects.toBeInstanceOf(NoUnitOfWorkError);
    });
  });
});

const listed: readonly RawReadEntry[] = [entry, ...RAW_READ_STATEMENTS];

describe.each(listed.map((e) => [e.id, e] as const))('raw read statement %s', (_id, statement) => {
  let app: Client;
  beforeAll(async () => {
    app = new Client({ connectionString: testDatabaseUrl() });
    await app.connect();
  });
  afterAll(async () => {
    await app.end();
  });

  it('plans against the real server and reads only ordinary tables (catalog check)', async () => {
    expect(await explainCatalogProblems(app, statement.sql, statement.owner)).toEqual([]);
  });
});

describe('BEGIN READ ONLY as the application role (Hassan C1)', () => {
  let app: Client;
  beforeAll(async () => {
    app = new Client({ connectionString: testDatabaseUrl() });
    await app.connect();
  });
  afterAll(async () => {
    await app.end();
  });

  it.each(listed.map((e) => [e.id, e] as const))(
    '%s runs read-only for both Markets',
    async (_id, statement) => {
      for (const code of TEST_MARKETS) {
        const values = statement.params.map((p) =>
          p.type === 'uuid[]'
            ? [randomUUID()]
            : p.type === 'text[]'
              ? ['x']
              : p.type === 'uuid'
                ? randomUUID()
                : 'x',
        );
        await expect(
          runReadOnly(app, statement.sql, [marketOf(code).marketId, ...values]),
        ).resolves.toBeDefined();
      }
    },
  );

  describe('negative controls, with grants that let only the read-only transaction refuse', () => {
    let owner: Client;
    beforeAll(async () => {
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      await owner.query(`
        CREATE TABLE IF NOT EXISTS public.raw_read_probe (market_id text, id int);
        CREATE SEQUENCE IF NOT EXISTS public.raw_read_probe_seq;
        GRANT SELECT, UPDATE, DELETE ON public.raw_read_probe TO mondapac_app;
        GRANT USAGE ON SEQUENCE public.raw_read_probe_seq TO mondapac_app`);
    });
    afterAll(async () => {
      await owner.query(
        'DROP TABLE IF EXISTS public.raw_read_probe; DROP SEQUENCE IF EXISTS public.raw_read_probe_seq',
      );
      await owner.end();
    });

    // 25006 read_only_sql_transaction: the privilege check passes, so only READ ONLY refuses.
    it.each([
      [
        'a data-modifying CTE',
        'WITH d AS (DELETE FROM public.raw_read_probe WHERE market_id = $1 RETURNING id) SELECT id FROM d',
      ],
      ['FOR UPDATE', 'SELECT id FROM public.raw_read_probe WHERE market_id = $1 FOR UPDATE'],
      ['nextval', "SELECT nextval('public.raw_read_probe_seq') WHERE $1::text IS NOT NULL"],
    ])('the database itself refuses %s', async (_name, sql) => {
      await expect(runReadOnly(app, sql, ['AU'])).rejects.toMatchObject({ code: '25006' });
    });

    it('would run the same nextval outside READ ONLY (the control is the transaction)', async () => {
      const result = await app.query("SELECT nextval('public.raw_read_probe_seq') AS n");
      expect(result.rows).toHaveLength(1);
    });

    it('catalog backstop fails closed on a view, a catalog table and another schema', async () => {
      await owner.query(`
        CREATE OR REPLACE VIEW certification.raw_read_probe_view AS
          SELECT id, market_id FROM certification.certification_types;
        GRANT SELECT ON certification.raw_read_probe_view TO mondapac_app`);
      try {
        expect(
          await explainCatalogProblems(
            app,
            'SELECT v.id FROM certification.raw_read_probe_view v WHERE v.market_id = $1',
            'certification',
          ),
        ).toContain('relation-not-a-table:certification.raw_read_probe_view');
        expect(
          await explainCatalogProblems(
            app,
            'SELECT c.oid FROM pg_catalog.pg_class c WHERE $1::text IS NOT NULL',
            'certification',
          ),
        ).toContain('relation-schema:pg_catalog.pg_class');
        expect(
          await explainCatalogProblems(
            app,
            'SELECT p.id FROM public.raw_read_probe p WHERE p.market_id = $1',
            'certification',
          ),
        ).toContain('relation-schema:public.raw_read_probe');
      } finally {
        await owner.query('DROP VIEW IF EXISTS certification.raw_read_probe_view');
      }
    });
  });
});
