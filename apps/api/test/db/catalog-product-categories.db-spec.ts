import type { MarketContext } from '@mondapac/shared-kernel';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaOwnCatalogReader } from '../../src/modules/catalog/infrastructure/prisma-own-catalog.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// `productCategories`, the category list of the seller's product form, on PostgreSQL for both
// Market fixtures: only active categories with a published revision of the asked Market come back,
// ordered by slug, each with the names of its published revision; another Market's categories,
// archived ones and ones with no published revision add nothing. The database is shared with other
// specs, so each check looks at the rows this spec created.

const T0 = '2026-11-18T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog product categories read in market %s (database)', (code) => {
  const market = marketOf(code);
  const otherMarket = marketOf(otherMarketOf(code));
  let owner: Client;
  let persistence: Persistence;
  let reader: PrismaOwnCatalogReader;

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    persistence = createPersistence();
    reader = new PrismaOwnCatalogReader(persistence.service);
  });
  afterAll(async () => {
    await owner.end();
    await persistence.close();
  });

  async function insert(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row);
    await owner.query(
      `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns
        .map((_, i) => `$${i + 1}`)
        .join(', ')})`,
      Object.values(row),
    );
  }
  const base = (m: MarketContext) => ({ market_id: m.marketId, tenant_id: m.tenantId });

  interface Seed {
    readonly status?: 'active' | 'archived';
    readonly published?: boolean;
    readonly parentId?: string | null;
  }
  /** One category of `m` with a revision carrying `names`; published unless `published` is false. */
  async function category(
    m: MarketContext,
    slug: string,
    names: Record<string, string>,
    seed: Seed = {},
  ): Promise<string> {
    const id = uuid7();
    const revisionId = uuid7();
    await owner.query(
      `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
         ON CONFLICT DO NOTHING`,
      [m.marketId, m.tenantId],
    );
    await insert('platform_categories', {
      id,
      ...base(m),
      slug,
      parent_id: seed.parentId ?? null,
      status: seed.status ?? 'active',
      merged_into_id: null,
      vertical_root_code: null,
      published_revision_id: null,
      created_by_kind: 'seed',
      version: 1,
      created_at: T0,
    });
    await insert('platform_category_revisions', {
      id: revisionId,
      ...base(m),
      category_id: id,
      revision_no: 1,
      parent_id: seed.parentId ?? null,
      change_kind: 'created',
      author_kind: 'seed',
      author_account_id: null,
      created_at: T0,
    });
    for (const [locale, name] of Object.entries(names)) {
      await insert('platform_category_revision_names', {
        ...base(m),
        revision_id: revisionId,
        locale,
        name,
      });
    }
    if (seed.published !== false) {
      await owner.query(
        `UPDATE catalog.platform_categories SET published_revision_id = $3
          WHERE market_id = $1 AND id = $2`,
        [m.marketId, id, revisionId],
      );
    }
    return id;
  }

  // As the use cases call it: inside a read-only unit of work (ADR-0025).
  const read = (m: MarketContext) =>
    persistence.unitOfWork
      .run(m, async () => ({ ok: true as const, value: await reader.productCategories(m) }), {
        readOnly: true,
      })
      .then((result) => {
        if (!result.ok) throw new Error('unit failed');
        return result.value;
      });

  it('returns only the active, published categories of the asked Market, ordered by slug', async () => {
    const tag = uuid7().slice(-10);
    // Created out of slug order, so the order seen comes from the query and not from insertion.
    const second = await category(market, `b-${tag}`, { 'en-US': 'Second', 'fr-FR': 'Deuxieme' });
    const root = await category(market, `a-${tag}`, { 'en-US': 'First' });
    const child = await category(market, `c-${tag}`, { 'en-US': 'Third' }, { parentId: root });
    const archived = await category(market, `d-${tag}`, { 'en-US': 'Old' }, { status: 'archived' });
    const draft = await category(market, `e-${tag}`, { 'en-US': 'Draft' }, { published: false });
    const foreign = await category(otherMarket, `f-${tag}`, { 'en-US': 'Elsewhere' });
    const created = [second, root, child, archived, draft, foreign];

    const rows = await read(market);
    expect(rows.filter((row) => created.includes(row.categoryId))).toEqual([
      { categoryId: root, parentId: null, names: { 'en-US': 'First' } },
      { categoryId: second, parentId: null, names: { 'en-US': 'Second', 'fr-FR': 'Deuxieme' } },
      { categoryId: child, parentId: root, names: { 'en-US': 'Third' } },
    ]);

    const theirs = (await read(otherMarket)).map((row) => row.categoryId);
    expect(theirs).toContain(foreign);
    for (const id of [second, root, child, archived, draft]) expect(theirs).not.toContain(id);
  });

  it('returns nothing for a Market with no categories', async () => {
    expect(await read(marketOf('QQ'))).toEqual([]);
  });
});
