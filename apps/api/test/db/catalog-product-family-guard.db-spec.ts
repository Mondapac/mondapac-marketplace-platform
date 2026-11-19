import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The family guard on PostgreSQL (attributes plan A4, CAT-10 change; migration
// 20261105210000_catalog_product_family_follows_category), for both Market fixtures, as the API
// role: the family can be written only in the same UPDATE that moves a revision pointer; type
// changes only simple to configurable (Add sizes, see catalog-product-add-sizes.db-spec.ts).

const T0 = Temporal.Instant.from('2026-11-05T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('product family guard in market %s (database)', (code) => {
  const market = marketOf(code);
  let db: Persistence;
  let owner: Client;
  let app: Client;
  let products: PrismaProductRepository;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    app = new Client({ connectionString: testDatabaseUrl() });
    await app.connect();
    products = new PrismaProductRepository(db.service);
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
    await db.close();
  });

  async function newProduct(): Promise<string> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: market.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `F${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: uuid7() as Id<'Variant'>,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await db.unitOfWork.run(market, async () => ok(await products.add(market, created.value)));
    return created.value.state.id;
  }

  /** A first revision of the product, with its own feature set and family revision. */
  async function revisionOf(id: string): Promise<string> {
    const revisionId = uuid7();
    const familyId = uuid7();
    const familyRevisionId = uuid7();
    await owner.query(
      `INSERT INTO catalog.attribute_families
         (id, market_id, tenant_id, code, status, created_by_kind, version, created_at)
       SELECT $1::uuid, $2::text, tenant_id, $3::text, 'active', 'seed', 1, now()
         FROM catalog.products WHERE market_id = $2::text AND id = $4::uuid`,
      [familyId, market.marketId, `g-${familyId.slice(-10)}`, id],
    );
    await owner.query(
      `INSERT INTO catalog.attribute_family_revisions
         (id, market_id, tenant_id, family_id, revision_no, groups, author_kind, created_at)
       SELECT $1::uuid, $2::text, tenant_id, $3::uuid, 1, '[]', 'seed', now()
         FROM catalog.products WHERE market_id = $2::text AND id = $4::uuid`,
      [familyRevisionId, market.marketId, familyId, id],
    );
    await owner.query(
      `INSERT INTO catalog.product_revisions
         (id, market_id, tenant_id, product_id, revision_no, revision_kind, family_revision_id,
          definition_revision_ids, tax_category_code, attribute_values, sensitive, sensitive_reasons,
          content_schema_version, content_hash, author_kind, author_account_id, submitted_at, type_code)
       SELECT $1::uuid, $2::text, tenant_id, $3::uuid, 1, 'submission', $4::uuid, '{}', 'standard', '{}', false, '{}', 1, $5::text,
              'admin', $6::uuid, now(), 'simple'
         FROM catalog.products WHERE market_id = $2::text AND id = $3::uuid`,
      [revisionId, market.marketId, id, familyRevisionId, `sha256:${'1'.repeat(64)}`, uuid7()],
    );
    return revisionId;
  }

  /** One UPDATE of one column to 'other', as the API role (a plain connection, no transaction). */
  const asApp = async (productId: string, which: 'family' | 'type'): Promise<void> => {
    const column = which === 'family' ? 'family_code' : 'type_code';
    await app.query(
      `UPDATE catalog.products SET ${column} = 'other' WHERE market_id = $1 AND id = $2`,
      [market.marketId, productId],
    );
  };

  it('refuses a family change on its own and a type change (both 23514)', async () => {
    const id = await newProduct();
    await expect(asApp(id, 'family')).rejects.toMatchObject({ code: '23514' });
    // The type column is updatable only for Add sizes (simple to configurable, with variant_model);
    // the trigger products_type_change_guard refuses any other write.
    await expect(asApp(id, 'type')).rejects.toMatchObject({ code: '23514' });
    const row = await owner.query(
      'SELECT family_code FROM catalog.products WHERE market_id = $1 AND id = $2',
      [market.marketId, id],
    );
    expect(row.rows[0]).toEqual({ family_code: 'default' });
  });

  it('allows the family together with a revision pointer', async () => {
    const id = await newProduct();
    const revisionId = await revisionOf(id);
    await app.query(
      `UPDATE catalog.products SET family_code = 'other', pending_revision_id = $3, pending_submitted_at = now()
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, id, revisionId],
    );
    const row = await owner.query(
      'SELECT family_code FROM catalog.products WHERE market_id = $1 AND id = $2',
      [market.marketId, id],
    );
    expect(row.rows[0]).toEqual({ family_code: 'other' });
  });

  it('lets a same-value family write and a pointer-only update through', async () => {
    const id = await newProduct();
    await app.query(
      'UPDATE catalog.products SET family_code = family_code WHERE market_id = $1 AND id = $2',
      [market.marketId, id],
    );
    const revisionId = await revisionOf(id);
    await app.query(
      `UPDATE catalog.products SET published_revision_id = $3, status = 'published'
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, id, revisionId],
    );
    const row = await owner.query(
      'SELECT family_code FROM catalog.products WHERE market_id = $1 AND id = $2',
      [market.marketId, id],
    );
    expect(row.rows[0]).toEqual({ family_code: 'default' });
  });

  it('lets the family change together with the published pointer', async () => {
    const id = await newProduct();
    const revisionId = await revisionOf(id);
    await app.query(
      `UPDATE catalog.products SET family_code = 'other', published_revision_id = $3, status = 'published'
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, id, revisionId],
    );
    const row = await owner.query(
      'SELECT family_code FROM catalog.products WHERE market_id = $1 AND id = $2',
      [market.marketId, id],
    );
    expect(row.rows[0]).toEqual({ family_code: 'other' });
  });
});
