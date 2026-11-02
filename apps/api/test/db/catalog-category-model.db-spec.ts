import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { sqlState } from './sql-state';
import { applicationDatabaseUrl, migrationDatabaseUrl, REPO_ROOT } from './test-database';

// Categories package C2 on PostgreSQL (catalog data design 3.4, 3.9, 5.1, 7), for both Market
// fixtures. The spec builds a database of its own, applies every migration but the C2 one, inserts
// a small tree with names and products with categories, then applies the C2 migration and checks
// the backfills (position order, names kept, one primary category) and the new constraints,
// triggers and grants on the application and the owner connections.

const MIGRATIONS = join(REPO_ROOT, 'prisma', 'migrations');
const C2_MIGRATION = '20261102130000_catalog_category_management_model';
const T0 = '2026-10-08T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

/**
 * The statements of a migration file. One query with several statements runs in an implicit
 * transaction, which `CREATE INDEX CONCURRENTLY` refuses; Prisma sends them one by one. Splits at
 * semicolons outside quotes, comments and dollar-quoted bodies.
 */
function statementsOf(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== c) j += 1;
      i = j + 1;
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))?.[0];
      if (tag === undefined) i += 1;
      else {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
      }
    } else if (c === ';') {
      out.push(sql.slice(start, i + 1));
      start = i + 1;
      i += 1;
    } else i += 1;
  }
  out.push(sql.slice(start));
  return out.filter((statement) => statement.replace(/--.*$/gm, '').trim() !== '');
}

interface Tree {
  readonly marketId: string;
  readonly ids: Record<string, string>;
  /** Product revisions: id and the categories as [slug, position] in insert order. */
  readonly revisions: { id: string; rows: [string, number][] }[];
}

describe('catalog category management model, migration C2 (database integration)', () => {
  const name = `catc2_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: Client;
  let owner: Client;
  let app: Client;
  const trees: Tree[] = [];

  const slugOf = (tag: string) => `${tag}-${randomUUID().slice(0, 6)}`;

  async function category(
    marketId: string,
    slug: string,
    parentId: string | null,
    names: Record<string, string>,
  ): Promise<string> {
    const id = uuid7();
    await owner.query(
      `INSERT INTO catalog.platform_categories (id, market_id, tenant_id, parent_id, slug, status,
         created_by_kind, version, created_at) VALUES ($1, $2, 'mondapac', $3, $4, 'active', 'seed', 1, $5)`,
      [id, marketId, parentId, slug, T0],
    );
    if (Object.keys(names).length === 0) return id;
    const revisionId = uuid7();
    await owner.query(
      `INSERT INTO catalog.platform_category_revisions (id, market_id, tenant_id, category_id, revision_no,
         parent_id, change_kind, author_kind, created_at) VALUES ($1, $2, 'mondapac', $3, 1, $4, 'created', 'seed', $5)`,
      [revisionId, marketId, id, parentId, T0],
    );
    for (const [locale, text] of Object.entries(names)) {
      await owner.query(
        `INSERT INTO catalog.platform_category_revision_names (market_id, tenant_id, revision_id, locale, name)
         VALUES ($1, 'mondapac', $2, $3, $4)`,
        [marketId, revisionId, locale, text],
      );
    }
    await owner.query(
      'UPDATE catalog.platform_categories SET published_revision_id = $2 WHERE id = $1',
      [id, revisionId],
    );
    return id;
  }

  async function productRevision(marketId: string): Promise<string> {
    const productId = uuid7();
    const revisionId = uuid7();
    await owner.query(
      `INSERT INTO catalog.products (id, market_id, tenant_id, scope, owner_seller_id, created_by_seller_id,
         type_code, variant_model, family_code, product_code, status, own_brand, last_changed_at,
         published_revision_id, version, created_at)
       VALUES ($1, $2, 'mondapac', 'PLATFORM', NULL, NULL, 'configurable', 'options', 'default', $3,
         'published', false, now(), $4, 1, now())`,
      [
        productId,
        marketId,
        `C${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        revisionId,
      ],
    );
    await owner.query(
      `INSERT INTO catalog.product_revisions (id, market_id, tenant_id, product_id, revision_no,
         revision_kind, family_revision_id, definition_revision_ids, tax_category_code, attribute_values,
         sensitive, sensitive_reasons, content_schema_version, content_hash, author_kind, author_account_id,
         submitted_at)
       VALUES ($1, $2, 'mondapac', $3, 1, 'submission', $4, '{}', 'standard', '{}'::jsonb, false, '{}', 1, $5,
         'admin', $6, now())`,
      [
        revisionId,
        marketId,
        productId,
        uuid7(),
        `sha256:${createHash('sha256').update(revisionId).digest('hex')}`,
        uuid7(),
      ],
    );
    return revisionId;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: migrationDatabaseUrl() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "mondapac_app"`);
    const ownerUrl = new URL(migrationDatabaseUrl());
    ownerUrl.pathname = `/${name}`;
    owner = new Client({ connectionString: ownerUrl.toString() });
    await owner.connect();
    const appUrl = new URL(applicationDatabaseUrl());
    appUrl.pathname = `/${name}`;
    app = new Client({ connectionString: appUrl.toString() });

    const folders = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toContain(C2_MIGRATION);
    const apply = async (folder: string) => {
      const sql = readFileSync(join(MIGRATIONS, folder, 'migration.sql'), 'utf8');
      if (/CONCURRENTLY/i.test(sql)) {
        for (const statement of statementsOf(sql)) await owner.query(statement);
      } else await owner.query(sql);
    };
    for (const folder of folders.filter((entry) => entry < C2_MIGRATION)) await apply(folder);

    // The fixtures stand alone: the keys that tie a product and its revision to the attribute
    // family are not the subject here.
    const constraints = await owner.query<{ table_name: string; conname: string }>(
      `SELECT c.relname AS table_name, k.conname
         FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'catalog' AND k.contype = 'f'
          AND c.relname IN ('products', 'product_revisions')`,
    );
    for (const row of constraints.rows) {
      await owner.query(`ALTER TABLE catalog.${row.table_name} DROP CONSTRAINT "${row.conname}"`);
    }

    for (const marketId of TEST_MARKETS) {
      // Inserted out of name order on purpose; the name of the first locale decides.
      const ids: Record<string, string> = {};
      ids.zeta = await category(marketId, slugOf('zeta'), null, { 'en-AU': 'Zeta' });
      ids.pantry = await category(marketId, slugOf('pantry'), null, {
        fa: 'خواربار',
        'en-AU': 'Pantry',
      });
      ids.alpha = await category(marketId, slugOf('alpha'), null, { 'en-AU': 'alpha' });
      ids.nameless = await category(marketId, slugOf('nameless'), null, {});
      ids.bakery = await category(marketId, slugOf('bakery'), null, { 'en-AU': 'Bakery' });
      ids.rice = await category(marketId, slugOf('rice'), ids.pantry, { 'en-AU': 'Rice' });
      ids.beans = await category(marketId, slugOf('beans'), ids.pantry, { 'en-AU': 'Beans' });
      ids.flour = await category(marketId, slugOf('flour'), ids.pantry, { 'en-AU': 'Flour' });

      const many = await productRevision(marketId);
      const single = await productRevision(marketId);
      const rows: [string, number][] = [
        ['rice', 2],
        ['flour', 1],
        ['beans', 3],
      ];
      for (const [slug, position] of rows) {
        await owner.query(
          `INSERT INTO catalog.product_revision_categories (market_id, tenant_id, revision_id, category_id, position)
           VALUES ($1, 'mondapac', $2, $3, $4)`,
          [marketId, many, ids[slug], position],
        );
      }
      await owner.query(
        `INSERT INTO catalog.product_revision_categories (market_id, tenant_id, revision_id, category_id, position)
         VALUES ($1, 'mondapac', $2, $3, 1)`,
        [marketId, single, ids.bakery],
      );
      trees.push({
        marketId,
        ids,
        revisions: [
          { id: many, rows },
          { id: single, rows: [['bakery', 1]] },
        ],
      });
    }

    await apply(C2_MIGRATION);
    await app.connect();
  });

  afterAll(async () => {
    await (app as Client | undefined)?.end().catch(() => undefined);
    await (owner as Client | undefined)?.end();
    await (admin as Client | undefined)?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await (admin as Client | undefined)?.end();
  });

  const treeOf = (marketId: string) => trees.find((tree) => tree.marketId === marketId)!;
  const marketTag = (marketId: string) => ({ marketId, tenant: 'mondapac' });

  describe.each(TEST_MARKETS)('backfill in Market %s', (marketId) => {
    it('numbers siblings from 0 in the order of the first-locale name, roots included', async () => {
      const { ids } = treeOf(marketId);
      const { rows } = await owner.query<{ id: string; position: number }>(
        'SELECT id, position FROM catalog.platform_categories WHERE market_id = $1',
        [marketId],
      );
      const position = new Map(rows.map((row) => [row.id, row.position]));
      expect(
        ['alpha', 'bakery', 'pantry', 'zeta', 'nameless'].map((key) => position.get(ids[key]!)),
      ).toEqual([0, 1, 2, 3, 4]);
      expect(['beans', 'flour', 'rice'].map((key) => position.get(ids[key]!))).toEqual([0, 1, 2]);
    });

    it('keeps every name readable and copies it to the per-locale texts', async () => {
      const names = await owner.query<{ revision_id: string; locale: string; name: string }>(
        'SELECT revision_id, locale, name FROM catalog.platform_category_revision_names WHERE market_id = $1',
        [marketId],
      );
      const texts = await owner.query<{
        revision_id: string;
        locale: string;
        name: string;
        short_description: string | null;
        keywords: string[];
      }>(
        'SELECT revision_id, locale, name, short_description, keywords FROM catalog.platform_category_revision_texts WHERE market_id = $1',
        [marketId],
      );
      expect(names.rows).toHaveLength(8);
      const key = (row: { revision_id: string; locale: string; name: string }) =>
        `${row.revision_id}|${row.locale}|${row.name}`;
      expect(texts.rows.map(key).sort()).toEqual(names.rows.map(key).sort());
      for (const row of texts.rows) {
        expect(row.short_description).toBeNull();
        expect(row.keywords).toEqual([]);
      }
    });

    it('marks the category with the lowest position primary, one per revision', async () => {
      const tree = treeOf(marketId);
      const { rows } = await owner.query<{
        revision_id: string;
        category_id: string;
        is_primary: boolean;
      }>(
        'SELECT revision_id, category_id, is_primary FROM catalog.product_revision_categories WHERE market_id = $1',
        [marketId],
      );
      for (const revision of tree.revisions) {
        const mine = rows.filter((row) => row.revision_id === revision.id);
        const primary = mine.filter((row) => row.is_primary);
        expect(primary).toHaveLength(1);
        const lowest = [...revision.rows].sort((a, b) => a[1] - b[1])[0]![0];
        expect(primary[0]!.category_id).toBe(tree.ids[lowest]);
      }
    });
  });

  it('puts the insert-only guard of product_revision_categories back after the backfill', async () => {
    const { ids, revisions } = treeOf(TEST_MARKETS[0]);
    const revision = revisions[0]!.id;
    for (const client of [owner, app]) {
      expect(
        await sqlState(
          client,
          'UPDATE catalog.product_revision_categories SET is_primary = false WHERE revision_id = $1',
          [revision],
        ),
      ).not.toBeNull();
    }
    expect(
      await sqlState(
        owner,
        'UPDATE catalog.product_revision_categories SET is_primary = false WHERE revision_id = $1 AND category_id = $2',
        [revision, ids.flour],
      ),
    ).toBe('23001');
    expect(
      await sqlState(
        owner,
        'DELETE FROM catalog.product_revision_categories WHERE revision_id = $1',
        [revision],
      ),
    ).toBe('23001');
  });

  describe.each(TEST_MARKETS)('constraints in Market %s', (marketId) => {
    const { tenant } = marketTag(marketId);

    async function freshCategory(
      parentId: string | null = null,
      overrides: Record<string, unknown> = {},
    ) {
      const id = uuid7();
      const row = {
        id,
        market_id: marketId,
        tenant_id: tenant,
        parent_id: parentId,
        slug: slugOf('c'),
        status: 'active',
        created_by_kind: 'seed',
        version: 1,
        created_at: T0,
        ...overrides,
      };
      const columns = Object.keys(row);
      await owner.query(
        `INSERT INTO catalog.platform_categories (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
      return id;
    }

    async function revisionOf(
      categoryId: string,
      revisionNo = 1,
      extra: Record<string, unknown> = {},
    ) {
      const row = {
        id: uuid7(),
        market_id: marketId,
        tenant_id: tenant,
        category_id: categoryId,
        revision_no: revisionNo,
        parent_id: null,
        change_kind: 'created',
        author_kind: 'seed',
        author_account_id: null,
        created_at: T0,
        ...extra,
      };
      const columns = Object.keys(row);
      await owner.query(
        `INSERT INTO catalog.platform_category_revisions (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
      return row.id;
    }

    const insertText = (
      revisionId: string,
      locale: string,
      text: Record<string, unknown>,
      client = app,
    ) =>
      sqlState(
        client,
        `INSERT INTO catalog.platform_category_revision_texts
           (market_id, tenant_id, revision_id, locale, name, short_description, keywords)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          marketId,
          tenant,
          revisionId,
          locale,
          text.name ?? 'A name',
          text.short ?? null,
          text.keywords ?? [],
        ],
      );

    it('accepts the hidden status and refuses an unknown one', async () => {
      await expect(freshCategory(null, { status: 'hidden' })).resolves.toBeTruthy();
      await expect(freshCategory(null, { status: 'secret' })).rejects.toMatchObject({
        code: '23514',
      });
    });

    it('accepts the new change kinds and a reason of 10 to 500 characters', async () => {
      const id = await freshCategory();
      const kinds = [
        'details-changed',
        'reordered',
        'hidden',
        'shown',
        'slug-changed',
        'discarded',
        'moved',
      ];
      let no = 1;
      for (const kind of kinds) {
        await expect(revisionOf(id, no++, { change_kind: kind })).resolves.toBeTruthy();
      }
      await expect(revisionOf(id, no++, { change_kind: 'bogus' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(revisionOf(id, no++, { reason: 'too short' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(revisionOf(id, no++, { reason: ' padded reason ' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(revisionOf(id, no++, { reason: 'x'.repeat(501) })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(revisionOf(id, no++, { reason: 'x'.repeat(10) })).resolves.toBeTruthy();
      await expect(revisionOf(id, no, { reason: 'y'.repeat(500) })).resolves.toBeTruthy();
    });

    it('checks the per-locale texts: name, description, keywords', async () => {
      const revision = await revisionOf(await freshCategory());
      expect(
        await insertText(revision, 'en-AU', {
          name: 'Rice',
          short: 'Long grain',
          keywords: ['rice', 'basmati'],
        }),
      ).toBeNull();
      expect(await insertText(revision, 'fa', { name: 'برنج', keywords: [] })).toBeNull();
      expect(await insertText(revision, 'ar', { name: '' })).toBe('23514');
      expect(await insertText(revision, 'de', { name: ' padded' })).toBe('23514');
      expect(await insertText(revision, 'fr', { name: 'x'.repeat(121) })).toBe('23514');
      expect(await insertText(revision, 'es', { short: 'x'.repeat(301) })).toBe('23514');
      expect(await insertText(revision, 'it', { short: 'x'.repeat(300) })).toBeNull();
      expect(
        await insertText(revision, 'nl', {
          keywords: Array.from({ length: 21 }, (_, i) => `k${i}`),
        }),
      ).toBe('23514');
      expect(
        await insertText(revision, 'pt', {
          keywords: Array.from({ length: 20 }, (_, i) => `k${i}`),
        }),
      ).toBeNull();
      expect(await insertText(revision, 'sv', { keywords: ['x'.repeat(41)] })).toBe('23514');
      expect(await insertText(revision, 'da', { keywords: [''] })).toBe('23514');
      expect(await insertText(revision, 'no', { keywords: [' pad'] })).toBe('23514');
      expect(await insertText(revision, 'is', { keywords: ['ok', null] })).toBe('23514');
      expect(await insertText(revision, 'ru', { keywords: ['bad\u0001join'] })).toBe('23514');
      expect(await insertText(revision, 'pl', { keywords: ['two words', 'نیم‌فاصله'] })).toBeNull();
      expect(await insertText(revision, 'fi', { keywords: ['x'.repeat(40)] })).toBeNull();
      expect(await insertText(revision, 'XX', {})).toBe('23514');
      // Same key twice.
      expect(await insertText(revision, 'en-AU', { name: 'Again' })).toBe('23505');
    });

    it('keeps the texts insert-only for the application role and the owner alike', async () => {
      const revision = await revisionOf(await freshCategory());
      expect(await insertText(revision, 'en-AU', { name: 'Fixed' })).toBeNull();
      for (const client of [app, owner]) {
        expect(
          await sqlState(
            client,
            "UPDATE catalog.platform_category_revision_texts SET name = 'Other' WHERE revision_id = $1",
            [revision],
          ),
        ).not.toBeNull();
        expect(
          await sqlState(
            client,
            'DELETE FROM catalog.platform_category_revision_texts WHERE revision_id = $1',
            [revision],
          ),
        ).not.toBeNull();
      }
      expect(
        await sqlState(
          owner,
          "UPDATE catalog.platform_category_revision_texts SET name = 'Other' WHERE revision_id = $1",
          [revision],
        ),
      ).toBe('23001');
      expect(
        await sqlState(
          owner,
          'DELETE FROM catalog.platform_category_revision_texts WHERE revision_id = $1',
          [revision],
        ),
      ).toBe('23001');
      expect(await sqlState(owner, 'TRUNCATE catalog.platform_category_revision_texts')).toBe(
        '23001',
      );
      const stored = await owner.query<{ name: string }>(
        'SELECT name FROM catalog.platform_category_revision_texts WHERE revision_id = $1',
        [revision],
      );
      expect(stored.rows).toEqual([{ name: 'Fixed' }]);
    });

    it('copies a new name row to the texts, and tolerates a text written first', async () => {
      const revision = await revisionOf(await freshCategory());
      await app.query(
        `INSERT INTO catalog.platform_category_revision_names (market_id, tenant_id, revision_id, locale, name)
         VALUES ($1, $2, $3, 'en-AU', 'Copied')`,
        [marketId, tenant, revision],
      );
      expect(await insertText(revision, 'fa', { name: 'نخست', keywords: ['a'] })).toBeNull();
      expect(
        await sqlState(
          app,
          `INSERT INTO catalog.platform_category_revision_names (market_id, tenant_id, revision_id, locale, name)
           VALUES ($1, $2, $3, 'fa', 'نخست')`,
          [marketId, tenant, revision],
        ),
      ).toBeNull();
      const { rows } = await owner.query<{ locale: string; name: string; keywords: string[] }>(
        'SELECT locale, name, keywords FROM catalog.platform_category_revision_texts WHERE revision_id = $1 ORDER BY locale',
        [revision],
      );
      expect(rows).toEqual([
        { locale: 'en-AU', name: 'Copied', keywords: [] },
        { locale: 'fa', name: 'نخست', keywords: ['a'] },
      ]);
    });

    it('keeps the slug history unique per slug and instant, insert-only, and per Market', async () => {
      const id = await freshCategory();
      const slug = slugOf('old');
      const insertHistory = (retiredAt: string, client = app, category = id) =>
        sqlState(
          client,
          `INSERT INTO catalog.platform_category_slug_history (market_id, tenant_id, slug, category_id, retired_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [marketId, tenant, slug, category, retiredAt],
        );
      expect(await insertHistory('2026-01-01T00:00:00Z')).toBeNull();
      expect(await insertHistory('2026-01-01T00:00:00Z')).toBe('23505');
      // Retired again years later by another category.
      const other = await freshCategory();
      expect(await insertHistory('2028-01-01T00:00:00Z', app, other)).toBeNull();
      expect(
        await sqlState(
          app,
          `INSERT INTO catalog.platform_category_slug_history (market_id, tenant_id, slug, category_id, retired_at)
           VALUES ($1, $2, 'Bad_Slug', $3, $4)`,
          [marketId, tenant, id, T0],
        ),
      ).toBe('23514');
      for (const client of [app, owner]) {
        expect(
          await sqlState(
            client,
            "UPDATE catalog.platform_category_slug_history SET slug = 'zz' WHERE slug = $1",
            [slug],
          ),
        ).not.toBeNull();
        expect(
          await sqlState(
            client,
            'DELETE FROM catalog.platform_category_slug_history WHERE slug = $1',
            [slug],
          ),
        ).not.toBeNull();
      }
      expect(
        await sqlState(
          owner,
          'DELETE FROM catalog.platform_category_slug_history WHERE slug = $1',
          [slug],
        ),
      ).toBe('23001');
      expect(await sqlState(owner, 'TRUNCATE catalog.platform_category_slug_history')).toBe(
        '23001',
      );
      // A category of another Market cannot be named (composite key).
      const otherMarket = TEST_MARKETS.find((code) => code !== marketId)!;
      expect(
        await sqlState(
          app,
          `INSERT INTO catalog.platform_category_slug_history (market_id, tenant_id, slug, category_id, retired_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [otherMarket, tenant, slugOf('x'), id, T0],
        ),
      ).toBe('23503');
    });

    it('refuses a slug another category retired less than 12 months ago, and lets the owner of it return', async () => {
      const retiree = await freshCategory();
      const recent = slugOf('recent');
      const aged = slugOf('aged');
      await owner.query(
        `INSERT INTO catalog.platform_category_slug_history (market_id, tenant_id, slug, category_id, retired_at)
         VALUES ($1, $3, $2, $4, now() - interval '11 months'), ($1, $3, $5, $4, now() - interval '13 months')`,
        [marketId, recent, tenant, retiree, aged],
      );
      await expect(freshCategory(null, { slug: recent })).rejects.toMatchObject({ code: '23514' });
      await expect(freshCategory(null, { slug: aged })).resolves.toBeTruthy();
      // The category that retired it may take it back (the owner role; the application cannot change a slug yet).
      await expect(
        owner.query('UPDATE catalog.platform_categories SET slug = $2 WHERE id = $1', [
          retiree,
          recent,
        ]),
      ).resolves.toBeTruthy();
      // Another category cannot move onto it by an update either.
      const mover = await freshCategory();
      const second = slugOf('second');
      await owner.query(
        `INSERT INTO catalog.platform_category_slug_history (market_id, tenant_id, slug, category_id, retired_at)
         VALUES ($1, $2, $3, $4, now())`,
        [marketId, tenant, second, retiree],
      );
      expect(
        await sqlState(owner, 'UPDATE catalog.platform_categories SET slug = $2 WHERE id = $1', [
          mover,
          second,
        ]),
      ).toBe('23514');
    });

    it('allows one position per sibling, roots included, and numbers a row without one last', async () => {
      const parent = await freshCategory();
      const a = await freshCategory(parent);
      const b = await freshCategory(parent);
      const c = await freshCategory(parent);
      const positions = await owner.query<{ id: string; position: number }>(
        'SELECT id, position FROM catalog.platform_categories WHERE parent_id = $1 ORDER BY position',
        [parent],
      );
      expect(positions.rows.map((row) => row.id)).toEqual([a, b, c]);
      expect(positions.rows.map((row) => row.position)).toEqual([0, 1, 2]);
      expect(
        await sqlState(app, 'UPDATE catalog.platform_categories SET position = 0 WHERE id = $1', [
          b,
        ]),
      ).toBe('23505');
      // Two roots at one position clash too (NULLS NOT DISTINCT).
      const root = await freshCategory();
      const rootPosition = (
        await owner.query<{ position: number }>(
          'SELECT position FROM catalog.platform_categories WHERE id = $1',
          [root],
        )
      ).rows[0]!.position;
      await expect(freshCategory(null, { position: rootPosition })).rejects.toMatchObject({
        code: '23505',
      });
      await expect(freshCategory(parent, { position: -2 })).rejects.toMatchObject({
        code: '23514',
      });
      // Another parent may reuse a position.
      const other = await freshCategory();
      await expect(freshCategory(other, { position: 0 })).resolves.toBeTruthy();
    });

    it('lets a reorder swap two positions inside one transaction (deferrable)', async () => {
      const parent = await freshCategory();
      const a = await freshCategory(parent);
      const b = await freshCategory(parent);
      await app.query('BEGIN');
      try {
        await app.query(
          'SET CONSTRAINTS catalog.platform_categories_market_id_parent_id_position_key DEFERRED',
        );
        await app.query('UPDATE catalog.platform_categories SET position = 1 WHERE id = $1', [a]);
        await app.query('UPDATE catalog.platform_categories SET position = 0 WHERE id = $1', [b]);
        await app.query('COMMIT');
      } catch (error) {
        await app.query('ROLLBACK');
        throw error;
      }
      const { rows } = await owner.query<{ id: string }>(
        'SELECT id FROM catalog.platform_categories WHERE parent_id = $1 ORDER BY position',
        [parent],
      );
      expect(rows.map((row) => row.id)).toEqual([b, a]);
      // An unresolved clash still fails at commit.
      await app.query('BEGIN');
      await app.query(
        'SET CONSTRAINTS catalog.platform_categories_market_id_parent_id_position_key DEFERRED',
      );
      await app.query('UPDATE catalog.platform_categories SET position = 0 WHERE id = $1', [a]);
      await expect(app.query('COMMIT')).rejects.toMatchObject({ code: '23505' });
    });

    it('checks the SEO fields and gives the editor exactly its columns', async () => {
      const id = await freshCategory();
      const update = (set: string, value: unknown) =>
        sqlState(app, `UPDATE catalog.platform_categories SET ${set} = $2 WHERE id = $1`, [
          id,
          value,
        ]);
      expect(await update('seo_title', 'x'.repeat(60))).toBeNull();
      expect(await update('seo_title', 'x'.repeat(61))).toBe('23514');
      expect(await update('seo_title', ' padded')).toBe('23514');
      expect(await update('seo_description', 'x'.repeat(160))).toBeNull();
      expect(await update('seo_description', 'x'.repeat(161))).toBe('23514');
      expect(await update('seo_noindex', true)).toBeNull();
      expect(await update('show_in_menu', false)).toBeNull();
      expect(await update('image_id', uuid7())).toBeNull();
      expect(await update('status', 'hidden')).toBeNull();
      expect(await update('slug', 'new-slug')).toBe('42501');
      expect(await update('market_id', 'ZZ')).toBe('42501');
    });

    it('allows one primary category per product revision, partial unique', async () => {
      const revision = await productRevision(marketId);
      const first = await freshCategory();
      const second = await freshCategory();
      const insertRow = (categoryId: string, position: number, primary: boolean) =>
        sqlState(
          app,
          `INSERT INTO catalog.product_revision_categories (market_id, tenant_id, revision_id, category_id, position, is_primary)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [marketId, tenant, revision, categoryId, position, primary],
        );
      expect(await insertRow(first, 1, true)).toBeNull();
      expect(await insertRow(second, 2, true)).toBe('23505');
      expect(await insertRow(second, 2, false)).toBeNull();
      // Another revision has its own primary.
      const again = await productRevision(marketId);
      expect(
        await sqlState(
          app,
          `INSERT INTO catalog.product_revision_categories (market_id, tenant_id, revision_id, category_id, position, is_primary)
           VALUES ($1, $2, $3, $4, 1, true)`,
          [marketId, tenant, again, first],
        ),
      ).toBeNull();
    });
  });
});
