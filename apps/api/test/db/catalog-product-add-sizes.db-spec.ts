import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Add sizes on PostgreSQL (catalog data design 3.1, 3.2, 3.7; migration
// 20261106210000_catalog_product_add_sizes), for both Market fixtures: the type moves once, simple
// to configurable together with variant_model, and the single variant follows by cascade; the
// variant guard refuses the way back; revisions carry type_code; the new sensitive reason and
// rate-counter kind are accepted.

const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('Add sizes in market %s (database)', (code) => {
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

  async function newProduct(): Promise<{ id: Id<'Product'>; variantId: Id<'Variant'> }> {
    const variantId = uuid7() as Id<'Variant'>;
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: market.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `A${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await db.unitOfWork.run(market, async () => ok(await products.add(market, created.value)));
    return { id: created.value.state.id, variantId };
  }

  const productRow = async (id: string) =>
    (
      await owner.query(
        'SELECT type_code, variant_model, version FROM catalog.products WHERE market_id = $1 AND id = $2',
        [market.marketId, id],
      )
    ).rows[0] as { type_code: string; variant_model: string; version: number };
  const variantRow = async (id: string) =>
    (
      await owner.query(
        'SELECT id, variant_no, variant_model FROM catalog.product_variants WHERE market_id = $1 AND product_id = $2',
        [market.marketId, id],
      )
    ).rows as { id: string; variant_no: number; variant_model: string }[];
  const setType = (id: string, type: string, model: string) =>
    app.query(
      'UPDATE catalog.products SET type_code = $3, variant_model = $4 WHERE market_id = $1 AND id = $2',
      [market.marketId, id, type, model],
    );

  it('moves a Simple product to Configurable once, and the single variant follows', async () => {
    const { id, variantId } = await newProduct();
    const before = await variantRow(id);
    await setType(id, 'configurable', 'options');
    expect(await productRow(id)).toMatchObject({
      type_code: 'configurable',
      variant_model: 'options',
    });
    expect(await variantRow(id)).toEqual([{ ...before[0], variant_model: 'options' }]);
    expect((await variantRow(id))[0]!.id).toBe(variantId);
  });

  it('refuses the way back and a type change without the model', async () => {
    const { id } = await newProduct();
    await expect(setType(id, 'configurable', 'single')).rejects.toMatchObject({ code: '23514' });
    await expect(setType(id, 'other', 'options')).rejects.toMatchObject({ code: '23514' });
    await setType(id, 'configurable', 'options');
    await expect(setType(id, 'simple', 'single')).rejects.toMatchObject({ code: '23514' });
    await expect(setType(id, 'simple', 'options')).rejects.toMatchObject({ code: '23514' });
    expect(await productRow(id)).toMatchObject({
      type_code: 'configurable',
      variant_model: 'options',
    });
  });

  it('lets a same-value write through', async () => {
    const { id } = await newProduct();
    await setType(id, 'simple', 'single');
    expect(await productRow(id)).toMatchObject({ type_code: 'simple' });
  });

  it('refuses a variant going from options to single', async () => {
    const { id } = await newProduct();
    await setType(id, 'configurable', 'options');
    await expect(
      owner.query(
        "UPDATE catalog.product_variants SET variant_model = 'single' WHERE market_id = $1 AND product_id = $2",
        [market.marketId, id],
      ),
    ).rejects.toBeDefined();
    expect((await variantRow(id))[0]!.variant_model).toBe('options');
  });

  it('stores the domain change through the repository', async () => {
    const { id } = await newProduct();
    await db.unitOfWork.run(market, async () => {
      const product = (await products.findById(market, id))!;
      const changed = product.addSizes({
        authorKind: 'admin',
        replacePending: false,
        revertFamilyCode: 'default',
        now: T0,
      });
      if (!changed.ok) throw new Error(changed.error.code);
      await products.save(market, product);
      return ok(undefined);
    });
    const row = await productRow(id);
    expect(row).toMatchObject({ type_code: 'configurable', variant_model: 'options' });
    expect(row.version).toBeGreaterThan(1);
    const loaded = await db.unitOfWork.run(market, async () =>
      ok(await products.findById(market, id)),
    );
    expect(loaded.ok && loaded.value!.state).toMatchObject({
      typeCode: 'configurable',
      variantModel: 'options',
    });
  });

  it('keeps type_code on revisions: required, shaped, and insert-only', async () => {
    const { id } = await newProduct();
    const familyRevisionId = uuid7();
    const insert = (typeCode: string | null, reasons: string) =>
      owner.query(
        `INSERT INTO catalog.product_revisions
           (id, market_id, tenant_id, product_id, revision_no, revision_kind, family_revision_id,
            definition_revision_ids, tax_category_code, attribute_values, sensitive, sensitive_reasons,
            content_schema_version, content_hash, author_kind, author_account_id, submitted_at, type_code)
         SELECT $1::uuid, $2::text, p.tenant_id, p.id, 1, 'submission', $8::uuid, '{}', 'standard', '{}',
                true, $5::text[], 1, $6::text, 'admin', $7::uuid, now(), $4::text
           FROM catalog.products p
          WHERE p.market_id = $2::text AND p.id = $3::uuid`,
        [
          uuid7(),
          market.marketId,
          id,
          typeCode,
          `{${reasons}}`,
          `sha256:${'2'.repeat(64)}`,
          uuid7(),
          familyRevisionId,
        ],
      );
    const familyId = uuid7();
    await owner.query(
      `INSERT INTO catalog.attribute_families
         (id, market_id, tenant_id, code, status, created_by_kind, version, created_at)
       SELECT $1::uuid, $2::text, tenant_id, $3::text, 'active', 'seed', 1, now()
         FROM catalog.products WHERE market_id = $2::text AND id = $4::uuid`,
      [familyId, market.marketId, `s-${familyId.slice(-10)}`, id],
    );
    await owner.query(
      `INSERT INTO catalog.attribute_family_revisions
         (id, market_id, tenant_id, family_id, revision_no, groups, author_kind, created_at)
       SELECT $1::uuid, $2::text, tenant_id, $3::uuid, 1, '[]', 'seed', now()
         FROM catalog.products WHERE market_id = $2::text AND id = $4::uuid`,
      [familyRevisionId, market.marketId, familyId, id],
    );
    await expect(insert(null, 'axis-added')).rejects.toMatchObject({ code: '23502' });
    await expect(insert('Bad Code', 'axis-added')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('simple', 'axis-added')).resolves.toBeDefined();
    await expect(
      owner.query(
        "UPDATE catalog.product_revisions SET type_code = 'configurable' WHERE market_id = $1 AND product_id = $2",
        [market.marketId, id],
      ),
    ).rejects.toBeDefined();
  });

  it('accepts the add-sizes rate-counter kind', async () => {
    const { rows } = await owner.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rate_counters_kind_check' AND conrelid = 'catalog.rate_counters'::regclass",
    );
    expect((rows[0] as { def: string }).def).toContain("'add-sizes.account.hour'");
  });
});
