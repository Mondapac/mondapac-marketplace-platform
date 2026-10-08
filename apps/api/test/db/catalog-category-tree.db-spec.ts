import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SeedCategoryTree } from '../../src/modules/catalog/application/use-cases/seed-category-tree.use-case';
import { ZZ_CATEGORY_TREE } from '../../src/modules/catalog/infrastructure/seed/zz.category-tree.seed';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Catalog slice 2 on PostgreSQL (catalog data design 3.4, 5.1, 7), for both Market fixtures: the
// constraints, the no-cycle trigger with its depth cap, the insert-only revisions and the
// grants of the migration, and the seed use case run twice through the real application.

const T0 = '2026-10-08T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog category tree in market %s (database integration)', (code) => {
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

  async function insertCategory(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = uuid7();
    const row = {
      id,
      market_id: market.marketId,
      tenant_id: market.tenantId,
      parent_id: null,
      slug: `t-${randomUUID().slice(0, 12)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0,
      ...overrides,
    };
    const columns = Object.keys(row);
    await sql.query(
      `INSERT INTO catalog.platform_categories (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
    return id;
  }

  async function insertRevision(categoryId: string, overrides: Record<string, unknown> = {}) {
    const row = {
      id: uuid7(),
      market_id: market.marketId,
      tenant_id: market.tenantId,
      category_id: categoryId,
      revision_no: 1,
      parent_id: null,
      change_kind: 'created',
      author_kind: 'seed',
      author_account_id: null,
      created_at: T0,
      ...overrides,
    };
    const columns = Object.keys(row);
    await sql.query(
      `INSERT INTO catalog.platform_category_revisions (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
    return row.id;
  }

  const seedContext = () => testCallContext(market, 'system', `db-catalog-seed-${randomUUID()}`);

  it('refuses a category that is its own parent, a bad slug and a vertical marker below a root', async () => {
    const id = uuid7();
    expect(
      await sqlState(
        sql,
        `INSERT INTO catalog.platform_categories
      (id, market_id, tenant_id, parent_id, slug, status, created_by_kind, version, created_at)
      VALUES ($1, $2, $3, $1, 'selfish', 'active', 'seed', 1, $4)`,
        [id, market.marketId, market.tenantId, T0],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        sql,
        `INSERT INTO catalog.platform_categories
      (id, market_id, tenant_id, slug, status, created_by_kind, version, created_at)
      VALUES ($1, $2, $3, 'Bad_Slug', 'active', 'seed', 1, $4)`,
        [uuid7(), market.marketId, market.tenantId, T0],
      ),
    ).toBe('23514');
    const root = await insertCategory();
    expect(
      await sqlState(
        sql,
        `INSERT INTO catalog.platform_categories
      (id, market_id, tenant_id, parent_id, vertical_root_code, slug, status, created_by_kind, version, created_at)
      VALUES ($1, $2, $3, $4, 'outdoor', 'child-marked', 'active', 'seed', 1, $5)`,
        [uuid7(), market.marketId, market.tenantId, root, T0],
      ),
    ).toBe('23514');
  });

  it('keeps a slug unique per Market and lets the other Market reuse it', async () => {
    const slug = `shared-${randomUUID().slice(0, 8)}`;
    await insertCategory({ slug });
    expect(
      await sqlState(
        sql,
        `INSERT INTO catalog.platform_categories
      (id, market_id, tenant_id, slug, status, created_by_kind, version, created_at)
      VALUES ($1, $2, $3, $4, 'active', 'seed', 1, $5)`,
        [uuid7(), market.marketId, market.tenantId, slug, T0],
      ),
    ).toBe('23505');
  });

  it('refuses a cycle and a 65th level, and accepts 64 levels', async () => {
    const root = await insertCategory();
    const ids = [root];
    for (let level = 1; level < 64; level++) {
      ids.push(await insertCategory({ parent_id: ids[level - 1] }));
    }
    expect(ids).toHaveLength(64);
    expect(
      await sqlState(sql, 'UPDATE catalog.platform_categories SET parent_id = $2 WHERE id = $1', [
        root,
        ids[63],
      ]),
    ).toBe('23514');
    expect(
      await sqlState(sql, 'UPDATE catalog.platform_categories SET parent_id = $2 WHERE id = $1', [
        ids[10],
        ids[40],
      ]),
    ).toBe('23514');
    // A 65th level exceeds the cap of 64.
    await expect(insertCategory({ parent_id: ids[63] })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a child row in another Market (composite foreign key)', async () => {
    const parent = await insertCategory();
    const otherMarket = marketOf(code === 'AU' ? 'ZZ' : 'AU');
    expect(
      await sqlState(
        sql,
        `INSERT INTO catalog.platform_categories
      (id, market_id, tenant_id, parent_id, slug, status, created_by_kind, version, created_at)
      VALUES ($1, $2, $3, $4, 'wrong-market', 'active', 'seed', 1, $5)`,
        [uuid7(), otherMarket.marketId, otherMarket.tenantId, parent, T0],
      ),
    ).toBe('23503');
  });

  it('keeps revisions and names insert-only for the application role and the owner alike', async () => {
    const id = await insertCategory();
    const revision = await insertRevision(id);
    await sql.query(
      `INSERT INTO catalog.platform_category_revision_names (market_id, tenant_id, revision_id, locale, name)
       VALUES ($1, $2, $3, 'xx', 'Fine name')`,
      [market.marketId, market.tenantId, revision],
    );
    for (const client of [sql, owner]) {
      expect(
        await sqlState(
          client,
          'UPDATE catalog.platform_category_revisions SET revision_no = 2 WHERE id = $1',
          [revision],
        ),
      ).not.toBeNull();
      expect(
        await sqlState(client, 'DELETE FROM catalog.platform_category_revisions WHERE id = $1', [
          revision,
        ]),
      ).not.toBeNull();
      expect(
        await sqlState(
          client,
          "UPDATE catalog.platform_category_revision_names SET name = 'Other' WHERE revision_id = $1",
          [revision],
        ),
      ).not.toBeNull();
    }
    // A referenced table is refused by its foreign keys before the trigger is reached.
    expect(await sqlState(owner, 'TRUNCATE catalog.platform_category_revisions')).not.toBeNull();
    expect(await sqlState(owner, 'TRUNCATE catalog.platform_category_revision_names')).toBe(
      '23001',
    );
  });

  it('checks revision author and names (S7 class, locale shape)', async () => {
    const id = await insertCategory();
    expect(
      await sqlState(
        sql,
        `INSERT INTO catalog.platform_category_revisions
      (id, market_id, tenant_id, category_id, revision_no, change_kind, author_kind, author_account_id, created_at)
      VALUES ($1, $2, $3, $4, 1, 'created', 'seed', $5, $6)`,
        [uuid7(), market.marketId, market.tenantId, id, uuid7(), T0],
      ),
    ).toBe('23514');
    const revision = await insertRevision(id);
    const insertName = (locale: string, name: string) =>
      sqlState(
        sql,
        `INSERT INTO catalog.platform_category_revision_names (market_id, tenant_id, revision_id, locale, name)
        VALUES ($1, $2, $3, $4, $5)`,
        [market.marketId, market.tenantId, revision, locale, name],
      );
    expect(await insertName('XX', 'Upper locale')).toBe('23514');
    expect(await insertName('xx', ' outer space')).toBe('23514');
    expect(await insertName('xx', 'bidi‮text')).toBe('23514');
    expect(await insertName('xx', '')).toBe('23514');
    expect(await insertName('xx', 'x'.repeat(121))).toBe('23514');
    expect(await insertName('xx', 'نیم‌فاصله')).toBeNull();
  });

  it('has no DELETE on the tree tables, and no UPDATE of a slug', async () => {
    const id = await insertCategory();
    expect(await sqlState(sql, 'DELETE FROM catalog.platform_categories WHERE id = $1', [id])).toBe(
      '42501',
    );
    expect(
      await sqlState(
        sql,
        "UPDATE catalog.platform_categories SET slug = 'renamed-slug' WHERE id = $1",
        [id],
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        sql,
        "UPDATE catalog.platform_categories SET created_by_kind = 'admin' WHERE id = $1",
        [id],
      ),
    ).toBe('42501');
    expect(await sqlState(sql, 'DELETE FROM catalog.category_trees')).toBe('42501');
  });

  it('seeds the Market tree once: ZZ gets its tree, AU stays empty, a second run changes nothing', async () => {
    const expected = code === 'ZZ' ? ZZ_CATEGORY_TREE.length : 0;
    const seed = app.get(SeedCategoryTree);
    const first = await seed.execute(seedContext(), {});
    const second = await seed.execute(seedContext(), {});
    expect(first.ok && second.ok).toBe(true);
    const slugs = ZZ_CATEGORY_TREE.map((entry) => entry.slug);
    const { rows } = await sql.query<{ slug: string; version: number; revision: string | null }>(
      `SELECT slug, version, published_revision_id AS revision FROM catalog.platform_categories
        WHERE market_id = $1 AND slug = ANY($2)`,
      [market.marketId, slugs],
    );
    expect(rows).toHaveLength(expected);
    expect(rows.every((row) => row.version === 1 && row.revision !== null)).toBe(true);

    if (code !== 'ZZ') {
      const seeded = await sql.query<{ n: string }>(
        `SELECT count(*) AS n FROM catalog.outbox WHERE market_id = $1
            AND type = 'catalog.platform-category-created.v1'`,
        [market.marketId],
      );
      expect(Number(seeded.rows[0]?.n)).toBe(0);
    }

    if (code === 'ZZ') {
      const tree = await sql.query<{ version: number }>(
        'SELECT version FROM catalog.category_trees WHERE market_id = $1',
        [market.marketId],
      );
      expect(tree.rows[0]?.version).toBeGreaterThanOrEqual(1 + expected);
      const parents = await sql.query<{ slug: string; parent: string | null }>(
        `SELECT c.slug, p.slug AS parent FROM catalog.platform_categories c
           LEFT JOIN catalog.platform_categories p ON p.market_id = c.market_id AND p.id = c.parent_id
          WHERE c.market_id = $1 AND c.slug = ANY($2)`,
        [market.marketId, slugs],
      );
      for (const entry of ZZ_CATEGORY_TREE) {
        expect(parents.rows.find((row) => row.slug === entry.slug)?.parent ?? null).toBe(
          entry.parentSlug,
        );
      }
      const events = await sql.query<{ n: string }>(
        `SELECT count(*) AS n FROM catalog.outbox WHERE market_id = $1
            AND type = 'catalog.platform-category-created.v1'`,
        [market.marketId],
      );
      expect(Number(events.rows[0]?.n)).toBe(expected);
    }
  });
});
