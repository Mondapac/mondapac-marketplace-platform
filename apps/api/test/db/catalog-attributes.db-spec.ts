import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SeedAttributes } from '../../src/modules/catalog/application/use-cases/seed-attributes.use-case';
import {
  ZZ_ATTRIBUTE_DEFINITIONS,
  ZZ_ATTRIBUTE_FAMILIES,
} from '../../src/modules/catalog/infrastructure/seed/zz.attributes.seed';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { PrismaAttributeRepository } from '../../src/modules/catalog/infrastructure/prisma-attribute.repository';
import { createPersistence, marketOf } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Catalog slice 3 on PostgreSQL (catalog data design 3.3, 5.1, 7), for both Market fixtures: the
// constraints, the insert-only revisions and the grants of the migration, and the seed use case
// run twice through the real application.

const T0 = '2026-10-08T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog attributes in market %s (database integration)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    ({ app } = await createTestApp({
      env: { DATABASE_URL: testDatabaseUrl() },
      override: (builder) =>
        builder.overrideProvider(CLOCK).useValue(new FixedClock(Temporal.Instant.from(T0))),
    }));
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
    await owner.end();
  });

  /** The SQLSTATE of a statement that must fail, or null when it succeeded. */
  async function sqlState(
    client: Client,
    text: string,
    values: unknown[] = [],
  ): Promise<string | null> {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  const seedContext = () => testCallContext(market, 'system', `db-catalog-seed-${randomUUID()}`);

  async function insertDefinition(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = uuid7();
    const row = {
      id,
      market_id: market.marketId,
      tenant_id: market.tenantId,
      code: `t-${randomUUID().slice(0, 12)}`,
      data_type: 'text',
      localizable: false,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0,
      ...overrides,
    };
    const columns = Object.keys(row);
    await sql.query(
      `INSERT INTO catalog.attribute_definitions (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
    return id;
  }

  async function insertRevision(definitionId: string, no = 1): Promise<string> {
    const id = uuid7();
    await sql.query(
      `INSERT INTO catalog.attribute_definition_revisions
        (id, market_id, tenant_id, definition_id, revision_no, material, is_variant_option, bounds, names, author_kind, created_at)
       VALUES ($1, $2, $3, $4, $5, false, false, '{}', '{"xx":"Name"}', 'seed', $6)`,
      [id, market.marketId, market.tenantId, definitionId, no, T0],
    );
    return id;
  }

  it('checks code, data type, status and creator kind of a definition', async () => {
    const insert = (overrides: Record<string, unknown>) =>
      sqlState(
        sql,
        `INSERT INTO catalog.attribute_definitions
          (id, market_id, tenant_id, code, data_type, localizable, status, created_by_kind, version, created_at)
         VALUES ($1, $2, $3, $4, $5, false, $6, $7, 1, $8)`,
        [
          uuid7(),
          market.marketId,
          market.tenantId,
          overrides.code ?? `c-${randomUUID().slice(0, 10)}`,
          overrides.dataType ?? 'text',
          overrides.status ?? 'active',
          overrides.kind ?? 'seed',
          T0,
        ],
      );
    expect(await insert({ code: 'Upper' })).toBe('23514');
    expect(await insert({ dataType: 'blob' })).toBe('23514');
    expect(await insert({ status: 'draft' })).toBe('23514');
    expect(await insert({ kind: 'robot' })).toBe('23514');
    expect(await insert({})).toBeNull();
    const code = `dup-${randomUUID().slice(0, 8)}`;
    expect(await insert({ code })).toBeNull();
    expect(await insert({ code })).toBe('23505');
  });

  it('keeps every revision table insert-only: 42501 for the application, 23001 for the owner', async () => {
    const definition = await insertDefinition({ data_type: 'select' });
    const revision = await insertRevision(definition);
    await sql.query(
      `INSERT INTO catalog.attribute_definition_revision_options
        (market_id, tenant_id, revision_id, option_code, labels, active, position)
       VALUES ($1, $2, $3, 'red', '{"xx":"Red"}', true, 0)`,
      [market.marketId, market.tenantId, revision],
    );
    const familyId = uuid7();
    await sql.query(
      `INSERT INTO catalog.attribute_families
        (id, market_id, tenant_id, code, status, created_by_kind, version, created_at)
       VALUES ($1, $2, $3, $4, 'active', 'seed', 1, $5)`,
      [familyId, market.marketId, market.tenantId, `f-${randomUUID().slice(0, 10)}`, T0],
    );
    const familyRevision = uuid7();
    await sql.query(
      `INSERT INTO catalog.attribute_family_revisions
        (id, market_id, tenant_id, family_id, revision_no, groups, author_kind, created_at)
       VALUES ($1, $2, $3, $4, 1, '[]', 'seed', $5)`,
      [familyRevision, market.marketId, market.tenantId, familyId, T0],
    );
    const cases = [
      ['attribute_definition_revisions', 'material = true', 'id', revision],
      ['attribute_definition_revision_options', 'active = false', 'revision_id', revision],
      ['attribute_family_revisions', "groups = '[{}]'", 'id', familyRevision],
    ] as const;
    for (const [table, set, key, value] of cases) {
      // The application holds no UPDATE or DELETE privilege on these tables at all.
      expect(
        await sqlState(sql, `UPDATE catalog.${table} SET ${set} WHERE ${key} = $1`, [value]),
      ).toBe('42501');
      expect(await sqlState(sql, `DELETE FROM catalog.${table} WHERE ${key} = $1`, [value])).toBe(
        '42501',
      );
      expect(await sqlState(sql, `TRUNCATE catalog.${table}`)).toBe('42501');
      // The owner is stopped by the trigger.
      expect(
        await sqlState(owner, `UPDATE catalog.${table} SET ${set} WHERE ${key} = $1`, [value]),
      ).toBe('23001');
      expect(await sqlState(owner, `DELETE FROM catalog.${table} WHERE ${key} = $1`, [value])).toBe(
        '23001',
      );
      expect(await sqlState(owner, `TRUNCATE catalog.${table} CASCADE`)).toBe('23001');
    }
    const unchanged = await sql.query<{ material: boolean; active: boolean }>(
      `SELECT r.material, o.active FROM catalog.attribute_definition_revisions r
         JOIN catalog.attribute_definition_revision_options o ON o.revision_id = r.id
        WHERE r.id = $1`,
      [revision],
    );
    expect(unchanged.rows).toEqual([{ material: false, active: true }]);
  });

  it('checks revision author, names, bounds and option shape', async () => {
    const definition = await insertDefinition();
    const insertRevisionRow = (
      names: string,
      bounds: string,
      kind: string,
      account: string | null,
    ) =>
      sqlState(
        sql,
        `INSERT INTO catalog.attribute_definition_revisions
          (id, market_id, tenant_id, definition_id, revision_no, material, is_variant_option, bounds, names, author_kind, author_account_id, created_at)
         VALUES ($1, $2, $3, $4, $5, false, false, $6, $7, $8, $9, $10)`,
        [
          uuid7(),
          market.marketId,
          market.tenantId,
          definition,
          sequence + 100,
          bounds,
          names,
          kind,
          account,
          T0,
        ],
      );
    expect(await insertRevisionRow('{}', '{}', 'seed', null)).toBe('23514');
    expect(await insertRevisionRow('[]', '{}', 'seed', null)).toBe('23514');
    expect(await insertRevisionRow('{"xx":"A"}', '[]', 'seed', null)).toBe('23514');
    expect(await insertRevisionRow('{"xx":"A"}', '{}', 'seed', uuid7())).toBe('23514');
    expect(await insertRevisionRow('{"xx":"A"}', '{}', 'admin', null)).toBe('23514');

    const revision = await insertRevision(definition, 1);
    const insertOption = (code: string, labels: string, position: number) =>
      sqlState(
        sql,
        `INSERT INTO catalog.attribute_definition_revision_options
          (market_id, tenant_id, revision_id, option_code, labels, active, position)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [market.marketId, market.tenantId, revision, code, labels, position],
      );
    expect(await insertOption('Red', '{"xx":"Red"}', 0)).toBe('23514');
    expect(await insertOption('red', '{}', 0)).toBe('23514');
    expect(await insertOption('red', '{"xx":"Red"}', -1)).toBe('23514');
    expect(await insertOption('red', '{"xx":"Red"}', 0)).toBeNull();
    expect(await insertOption('red', '{"xx":"Red"}', 1)).toBe('23505');
    expect(await sqlState(sql, 'SELECT 1')).toBeNull();
  });

  it('repeats no revision number and points only at its own revision', async () => {
    const first = await insertDefinition();
    const second = await insertDefinition();
    await insertRevision(first, 1);
    expect(await sqlState(sql, 'SELECT 1')).toBeNull();
    await expect(insertRevision(first, 1)).rejects.toMatchObject({ code: '23505' });
    const foreign = await insertRevision(second, 1);
    expect(
      await sqlState(
        sql,
        'UPDATE catalog.attribute_definitions SET published_revision_id = $2 WHERE id = $1',
        [first, foreign],
      ),
    ).toBe('23503');
  });

  it('has no DELETE on the attribute tables and no UPDATE of code, type or flags', async () => {
    const id = await insertDefinition();
    expect(
      await sqlState(sql, 'DELETE FROM catalog.attribute_definitions WHERE id = $1', [id]),
    ).toBe('42501');
    for (const column of ["code = 'renamed'", "data_type = 'integer'", 'localizable = true']) {
      expect(
        await sqlState(sql, `UPDATE catalog.attribute_definitions SET ${column} WHERE id = $1`, [
          id,
        ]),
      ).toBe('42501');
    }
    expect(await sqlState(sql, 'DELETE FROM catalog.attribute_families')).toBe('42501');
    expect(
      await sqlState(sql, "UPDATE catalog.attribute_families SET code = 'renamed' WHERE false"),
    ).toBe('42501');
  });

  it('seeds the Market once: ZZ gets its definitions and family, AU stays empty, a rerun changes nothing', async () => {
    const seed = app.get(SeedAttributes);
    const first = await seed.execute(seedContext(), {});
    const second = await seed.execute(seedContext(), {});
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toEqual({ definitions: 0, families: 0 });

    const definitions = await sql.query<{
      code: string;
      version: number;
      revision: string | null;
      material: boolean;
    }>(
      `SELECT d.code, d.version, d.published_revision_id AS revision, r.material
         FROM catalog.attribute_definitions d
         LEFT JOIN catalog.attribute_definition_revisions r
           ON r.market_id = d.market_id AND r.id = d.published_revision_id
        WHERE d.market_id = $1 AND d.code = ANY($2)`,
      [market.marketId, ZZ_ATTRIBUTE_DEFINITIONS.map((entry) => entry.code)],
    );
    const families = await sql.query<{ code: string; revision: string | null }>(
      `SELECT code, published_revision_id AS revision FROM catalog.attribute_families
        WHERE market_id = $1 AND code = ANY($2)`,
      [market.marketId, ZZ_ATTRIBUTE_FAMILIES.map((entry) => entry.code)],
    );
    if (code !== 'ZZ') {
      expect(definitions.rows).toHaveLength(0);
      expect(families.rows).toHaveLength(0);
      return;
    }
    expect(definitions.rows).toHaveLength(ZZ_ATTRIBUTE_DEFINITIONS.length);
    expect(definitions.rows.every((row) => row.version === 1 && row.revision !== null)).toBe(true);
    for (const seeded of ZZ_ATTRIBUTE_DEFINITIONS) {
      expect(definitions.rows.find((row) => row.code === seeded.code)?.material).toBe(
        seeded.material,
      );
    }
    expect(families.rows).toHaveLength(ZZ_ATTRIBUTE_FAMILIES.length);
    expect(families.rows.every((row) => row.revision !== null)).toBe(true);
    const options = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM catalog.attribute_definition_revision_options o
         JOIN catalog.attribute_definitions d
           ON d.market_id = o.market_id AND d.published_revision_id = o.revision_id
        WHERE o.market_id = $1 AND d.code = ANY($2)`,
      [market.marketId, ZZ_ATTRIBUTE_DEFINITIONS.map((entry) => entry.code)],
    );
    expect(Number(options.rows[0]?.n)).toBe(
      ZZ_ATTRIBUTE_DEFINITIONS.reduce((sum, entry) => sum + entry.options.length, 0),
    );
  });

  it('builds the schema of a seeded family from the published revisions, and none for an unknown one (4c-5b)', async () => {
    await app.get(SeedAttributes).execute(seedContext(), {});
    const persistence = createPersistence();
    try {
      const attributes = new PrismaAttributeRepository(persistence.service);
      const load = (familyCode: string) =>
        persistence.unitOfWork
          .run(market, async () => ({
            ok: true as const,
            value: await attributes.loadSchema(market, familyCode),
          }))
          .then((result) => (result.ok ? result.value : null));
      expect(await load('no-such-family')).toBeNull();
      const seeded = ZZ_ATTRIBUTE_FAMILIES[0]!;
      const schema = await load(seeded.code);
      if (code !== 'ZZ') {
        expect(schema).toBeNull();
        return;
      }
      expect(schema?.schemaRef.familyCode).toBe(seeded.code);
      expect(schema?.fields.map((field) => field.code).sort()).toEqual(
        seeded.groups.flatMap((group) => group.attributes.map((entry) => entry.code)).sort(),
      );
      expect(schema?.schemaRef.definitionRevisionIds).toHaveLength(schema?.fields.length ?? -1);
    } finally {
      await persistence.close();
    }
  });
});
