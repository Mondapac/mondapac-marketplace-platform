import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaProductDetailsGapReader } from '../../src/modules/catalog/infrastructure/prisma-product-details-gap.reader';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The reader of the report "Products missing required details" on PostgreSQL (attributes plan,
// package A4), for both Market fixtures, as the API role: only published products with a
// published revision are read, by id; a draft, a product only pending review and the other Market
// are not; the seller and feature-set filters, the cursor and the limit; and the name in the asked
// locale (null without one). Each test works on its own feature-set code, because other specs
// share the database.

const T0 = Temporal.Instant.from('2026-11-04T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => uuid7().replaceAll('-', '').slice(-10);

describe.each(TEST_MARKETS)('product details gap reader in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let reader: PrismaProductDetailsGapReader;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    reader = new PrismaProductDetailsGapReader(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    await owner.query(
      `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  const base = (target: typeof market) => ({
    market_id: target.marketId,
    tenant_id: target.tenantId,
  });

  async function family(
    target: typeof market,
    groups: readonly unknown[],
  ): Promise<{ id: Id<'AttributeFamily'>; code: string; revisionId: string }> {
    const id = uuid7();
    const revisionId = uuid7();
    const familyCode = `f-${unique()}`;
    await insert('attribute_families', {
      id,
      ...base(target),
      code: familyCode,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_family_revisions', {
      id: revisionId,
      ...base(target),
      family_id: id,
      revision_no: 1,
      groups: JSON.stringify(groups),
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    await owner.query(
      `UPDATE catalog.attribute_families SET published_revision_id = $3
        WHERE market_id = $1 AND id = $2`,
      [target.marketId, id, revisionId],
    );
    return { id: id as Id<'AttributeFamily'>, code: familyCode, revisionId };
  }

  /** A product with one revision; published unless told otherwise. */
  async function product(
    target: typeof market,
    familyCode: string,
    familyRevisionId: string,
    values: Record<string, unknown>,
    options: {
      readonly status?: 'published' | 'draft';
      readonly pendingOnly?: boolean;
      readonly sellerId?: string;
      readonly names?: Record<string, string>;
    } = {},
  ): Promise<string> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: options.sellerId === undefined ? 'PLATFORM' : 'SELLER',
      sellerId: (options.sellerId ?? null) as Id<'Seller'> | null,
      handler: simpleProductType,
      familyCode,
      productCode: `G${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: uuid7() as Id<'Variant'>,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const productId = created.value.state.id;
    await db.unitOfWork.run(target, async () => ok(await products.add(target, created.value)));
    const revisionId = uuid7();
    await insert('product_revisions', {
      id: revisionId,
      ...base(target),
      product_id: productId,
      revision_no: 1,
      revision_kind: 'submission',
      base_revision_id: null,
      reverted_from_revision_id: null,
      family_revision_id: familyRevisionId,
      definition_revision_ids: [],
      tax_category_code: 'standard',
      attribute_values: JSON.stringify(values),
      field_provenance: null,
      sensitive: false,
      sensitive_reasons: [],
      content_schema_version: 1,
      content_hash: `sha256:${'1'.repeat(64)}`,
      author_kind: 'admin',
      author_account_id: uuid7(),
      acting_admin_account_id: null,
      submitted_at: T0.toString(),
    });
    for (const [locale, name] of Object.entries(options.names ?? {})) {
      await insert('product_revision_texts', {
        ...base(target),
        revision_id: revisionId,
        locale,
        name,
      });
    }
    const status = options.pendingOnly === true ? 'unpublished' : (options.status ?? 'published');
    await owner.query(
      `UPDATE catalog.products
          SET status = $3, ${options.pendingOnly === true ? 'pending_revision_id' : 'published_revision_id'} = $4,
              pending_submitted_at = $5
        WHERE market_id = $1 AND id = $2`,
      [
        target.marketId,
        productId,
        status,
        status === 'draft' ? null : revisionId,
        options.pendingOnly === true ? T0.toString() : null,
      ],
    );
    return productId;
  }

  const read = (
    target: typeof market,
    familyCode: string,
    over: Partial<Parameters<PrismaProductDetailsGapReader['published']>[1]> = {},
  ) =>
    run(target, () =>
      reader.published(target, {
        afterId: null,
        sellerId: null,
        familyCode,
        limit: 50,
        locale: 'en-AU',
        ...over,
      }),
    );

  it('reads only published products, by id, with their values and name', async () => {
    const set = await family(market, []);
    const seller = uuid7();
    const a = await product(
      market,
      set.code,
      set.revisionId,
      { origin: 'AU' },
      {
        sellerId: seller,
        names: { 'en-AU': 'Dates', 'xx-XX': 'Other' },
      },
    );
    const b = await product(market, set.code, set.revisionId, {});
    await product(market, set.code, set.revisionId, { origin: 'no' }, { status: 'draft' });
    await product(market, set.code, set.revisionId, { origin: 'no' }, { pendingOnly: true });

    const rows = await read(market, set.code);
    expect(rows.map((row) => row.productId)).toEqual([a, b].sort());
    const first = rows.find((row) => row.productId === a)!;
    expect(first).toMatchObject({
      ownerSellerId: seller,
      familyCode: set.code,
      name: 'Dates',
      attributeValues: { origin: 'AU' },
    });
    expect(rows.find((row) => row.productId === b)).toMatchObject({
      ownerSellerId: null,
      name: null,
      attributeValues: {},
    });
  });

  it('filters by seller and feature set, and pages by the cursor', async () => {
    const set = await family(market, []);
    const otherSet = await family(market, []);
    const seller = uuid7();
    const ids = [
      await product(market, set.code, set.revisionId, {}, { sellerId: seller }),
      await product(market, set.code, set.revisionId, {}),
      await product(market, set.code, set.revisionId, {}, { sellerId: seller }),
    ].sort();
    await product(market, otherSet.code, otherSet.revisionId, {}, { sellerId: seller });

    const mine = await read(market, set.code, { sellerId: seller });
    expect(mine).toHaveLength(2);
    expect(mine.every((row) => row.ownerSellerId === seller)).toBe(true);
    const everyone = await read(market, set.code);
    expect(everyone.map((row) => row.productId)).toEqual(ids);

    const page = await read(market, set.code, { limit: 2 });
    expect(page.map((row) => row.productId)).toEqual(ids.slice(0, 2));
    const next = await read(market, set.code, { afterId: ids[1] ?? null, limit: 2 });
    expect(next.map((row) => row.productId)).toEqual(ids.slice(2));
  });

  it('never reads a product of the other Market', async () => {
    const set = await family(other, []);
    await product(other, set.code, set.revisionId, {});
    expect(await read(market, set.code)).toEqual([]);
    expect(await read(other, set.code)).toHaveLength(1);
  });
});
