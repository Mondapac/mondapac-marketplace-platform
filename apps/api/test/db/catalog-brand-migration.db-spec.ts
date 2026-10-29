import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseId, uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { brandNameKey } from '../../src/modules/catalog/domain/brand';
import { TEST_MARKETS } from '../support/test-config';
import { migrationDatabaseUrl, REPO_ROOT } from './test-database';

// The backfill of migration 20261028220000_catalog_brand, run against fixtures. The spec builds a
// database of its own (so no product of another file is backfilled), applies every migration but
// that one, inserts products whose published revision has a `brand` attribute in both Market
// fixtures, then applies the brand migration and reads the result.

const MIGRATIONS = join(REPO_ROOT, 'prisma', 'migrations');
const BRAND_MIGRATION = '20261028220000_catalog_brand';
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

interface Fixture {
  readonly marketId: string;
  readonly productId: string;
  /** The published revision's `brand` attribute value (a JSON value), or undefined for none. */
  readonly brand: unknown;
  readonly published: boolean;
}

describe('catalog brand migration backfill (database integration)', () => {
  const name = `brandmig_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: Client;
  let owner: Client;
  const fixtures: Fixture[] = [];

  const VALUES: readonly [string, unknown, boolean][] = [
    ['acme-upper', 'ACME TEA', true],
    ['acme-plain', 'Acme Tea', true],
    ['acme-padded', '  Acme Tea  ', true],
    ['acme-bang', 'Acme Tea!', true],
    ['fuji-amp', 'Fuji & Co.', true],
    ['fuji-and', 'FUJI AND CO', true],
    ['solo', 'Solo Brand', true],
    ['no-brand', undefined, true],
    ['blank', '   ', true],
    ['number', 42, true],
    ['symbols', '!!!', true],
    ['draft-only', 'Unpublished Brand', false],
  ];

  async function insertProduct(marketId: string, tag: string, brand: unknown, published: boolean) {
    const productId = uuid7();
    const revisionId = uuid7();
    await owner.query(
      `INSERT INTO catalog.products (id, market_id, tenant_id, scope, owner_seller_id, created_by_seller_id,
         type_code, variant_model, family_code, product_code, status, own_brand, last_changed_at,
         published_revision_id, version, created_at)
       VALUES ($1, $2, 'mondapac', 'PLATFORM', NULL, NULL, 'configurable', 'options', 'default', $3,
         $4, false, now(), $5, 1, now())`,
      [
        productId,
        marketId,
        `B${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        published ? 'published' : 'draft',
        published ? revisionId : null,
      ],
    );
    await owner.query(
      `INSERT INTO catalog.product_revisions (id, market_id, tenant_id, product_id, revision_no,
         revision_kind, family_revision_id, definition_revision_ids, tax_category_code, attribute_values,
         sensitive, sensitive_reasons,
         content_schema_version, content_hash, author_kind, author_account_id, submitted_at)
       VALUES ($1, $2, 'mondapac', $3, 1, 'submission', $4, '{}', 'standard', $5::jsonb, false, '{}', 1, $6, 'admin',
         $7, now())`,
      [
        revisionId,
        marketId,
        productId,
        uuid7(),
        JSON.stringify(brand === undefined ? { colour: 'red' } : { brand, colour: 'red' }),
        `sha256:${createHash('sha256').update(tag).digest('hex')}`,
        uuid7(),
      ],
    );
    return productId;
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

    const folders = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const before = folders.filter((folder) => folder < BRAND_MIGRATION);
    expect(folders).toContain(BRAND_MIGRATION);
    for (const folder of before) {
      const sql = readFileSync(join(MIGRATIONS, folder, 'migration.sql'), 'utf8');
      if (/CONCURRENTLY/i.test(sql)) {
        for (const statement of statementsOf(sql)) await owner.query(statement);
      } else await owner.query(sql);
    }

    // The fixtures stand alone: the foreign keys that tie a product and its revision to the
    // attribute family are not the subject here.
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
      for (const [tag, brand, published] of VALUES) {
        const productId = await insertProduct(marketId, `${marketId}-${tag}`, brand, published);
        fixtures.push({ marketId, productId, brand, published });
      }
    }
    await owner.query(readFileSync(join(MIGRATIONS, BRAND_MIGRATION, 'migration.sql'), 'utf8'));
  });

  afterAll(async () => {
    await (owner as Client | undefined)?.end();
    await (admin as Client | undefined)?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await (admin as Client | undefined)?.end();
  });

  const brandsByName = async () => {
    const { rows } = await owner.query<{
      id: string;
      slug: string;
      name: string;
      name_key: string;
      status: string;
      version: number;
    }>('SELECT id, slug, name, name_key, status, version FROM catalog.brands ORDER BY name');
    return new Map(rows.map((row) => [row.name, row]));
  };

  it('creates one active brand per distinct trimmed value, near-duplicates kept apart', async () => {
    const brands = await brandsByName();
    expect([...brands.keys()].sort()).toEqual(
      ['ACME TEA', 'Acme Tea', 'Acme Tea!', 'FUJI AND CO', 'Fuji & Co.', 'Solo Brand'].sort(),
    );
    for (const brand of brands.values()) {
      expect(brand.status).toBe('active');
      expect(brand.version).toBe(1);
    }
  });

  it('gives every brand a unique slug, suffixed when the base is taken, in byte order of the name', async () => {
    const brands = await brandsByName();
    const slugs = [...brands.values()].map((brand) => brand.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(brands.get('ACME TEA')!.slug).toBe('acme-tea');
    expect(brands.get('Acme Tea')!.slug).toBe('acme-tea-2');
    expect(brands.get('Acme Tea!')!.slug).toBe('acme-tea-3');
    expect(brands.get('Solo Brand')!.slug).toBe('solo-brand');
  });

  it('writes valid UUIDv7 ids and the same name key as the application', async () => {
    const brands = await brandsByName();
    for (const brand of brands.values()) {
      expect(() => parseId(brand.id)).not.toThrow();
      expect(brand.id[14]).toBe('7');
      expect(brand.name_key).toBe(brandNameKey(brand.name));
    }
    const candidates = await owner.query<{ id: string }>(
      'SELECT id FROM catalog.brand_merge_candidates',
    );
    for (const row of candidates.rows) expect(() => parseId(row.id)).not.toThrow();
  });

  it('sends near-duplicates to the merge queue, one open row per brand, and merges nothing', async () => {
    const brands = await brandsByName();
    const { rows } = await owner.query<{
      group_key: string;
      brand_id: string;
      status: string;
      resolution: string | null;
    }>('SELECT group_key, brand_id, status, resolution FROM catalog.brand_merge_candidates');
    const queued = new Map(rows.map((row) => [row.brand_id, row]));
    const expectedQueued = ['ACME TEA', 'Acme Tea', 'Acme Tea!', 'FUJI AND CO', 'Fuji & Co.'];
    expect(rows).toHaveLength(expectedQueued.length);
    for (const brandName of expectedQueued) {
      const entry = queued.get(brands.get(brandName)!.id)!;
      expect(entry).toMatchObject({ status: 'open', resolution: null });
      expect(entry.group_key).toBe(brandNameKey(brandName));
    }
    expect(queued.has(brands.get('Solo Brand')!.id)).toBe(false);
    expect(new Set(rows.map((row) => row.group_key))).toEqual(new Set(['acmetea', 'fujiandco']));
  });

  it.each(TEST_MARKETS)(
    'points each published product of Market %s at its brand and leaves the others null',
    async (marketId) => {
      const brands = await brandsByName();
      const { rows } = await owner.query<{ id: string; brand_id: string | null }>(
        'SELECT id, brand_id FROM catalog.products WHERE market_id = $1',
        [marketId],
      );
      const byId = new Map(rows.map((row) => [row.id, row.brand_id]));
      const expectedName = (value: unknown, published: boolean): string | null => {
        if (!published || typeof value !== 'string') return null;
        const trimmed = value.trim();
        return brandNameKey(trimmed) === '' ? null : trimmed;
      };
      const mine = fixtures.filter((fixture) => fixture.marketId === marketId);
      expect(mine).toHaveLength(VALUES.length);
      for (const fixture of mine) {
        const wanted = expectedName(fixture.brand, fixture.published);
        expect(byId.get(fixture.productId)).toBe(wanted === null ? null : brands.get(wanted)!.id);
      }
      // The padded value joins the plain one; the case variant stays apart.
      const plain = mine.find((fixture) => fixture.brand === 'Acme Tea')!;
      const padded = mine.find((fixture) => fixture.brand === '  Acme Tea  ')!;
      const upper = mine.find((fixture) => fixture.brand === 'ACME TEA')!;
      expect(byId.get(padded.productId)).toBe(byId.get(plain.productId));
      expect(byId.get(upper.productId)).not.toBe(byId.get(plain.productId));
    },
  );

  it('refuses a brand_id that names no brand, and the deletion of a brand', async () => {
    const [first] = fixtures;
    await expect(
      owner.query('UPDATE catalog.products SET brand_id = $1 WHERE id = $2', [
        uuid7(),
        first!.productId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(owner.query('DELETE FROM catalog.brands')).rejects.toBeDefined();
  });
});
