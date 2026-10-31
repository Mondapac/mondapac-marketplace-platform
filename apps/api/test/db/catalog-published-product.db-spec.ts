import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PlatformCategory } from '../../src/modules/catalog/domain/platform-category';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { PrismaPlatformCategoryRepository } from '../../src/modules/catalog/infrastructure/prisma-platform-category.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaBrandReader } from '../../src/modules/catalog/infrastructure/prisma-brand.reader';
import { PrismaPublishedProductReader } from '../../src/modules/catalog/infrastructure/prisma-published-product.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// `publishedProduct` reader on PostgreSQL, for both Market fixtures: the PUBLISHED revision's
// texts, categories (in revision order) and published Variants (in position order) only, a newer
// unpublished revision is never read, the locale fallback, a product that is not published, and
// the Market boundary (canary).

const T0 = Temporal.Instant.from('2026-10-16T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const LOCALES = { requested: 'en-AU', fallback: 'ja-JP' };

describe.each(TEST_MARKETS)('catalog published product in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let reader: PrismaPublishedProductReader;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    reader = new PrismaPublishedProductReader(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const run = async <T>(target: typeof market, work: () => Promise<T>, readOnly = false) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), { readOnly });
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

  interface Spec {
    texts: Record<string, { name: string; shortDescription?: string; description?: string }>;
    /** Variants of the revision in position order; `state` is the registry state. */
    variants: { state: 'proposed' | 'published' | 'retired'; labels: Record<string, string> }[];
  }

  /** A product; `published` becomes the published revision, `draft` a newer one. */
  async function product(
    target: typeof market,
    published: Spec | null,
    draft: Spec | null = null,
  ): Promise<{ productId: Id<'Product'>; variantIds: string[]; categoryIds: string[] }> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: configurableProductType,
      familyCode: 'default',
      productCode: `P${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: null,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    const productId = created.value.state.id;
    await run(target, () => products.add(target, created.value));
    const base = { market_id: target.marketId, tenant_id: target.tenantId };
    const familyId = uuid7();
    const familyRevisionId = uuid7();
    await insert('attribute_families', {
      id: familyId,
      ...base,
      code: `f-${uuid7().slice(-10)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_family_revisions', {
      id: familyRevisionId,
      ...base,
      family_id: familyId,
      revision_no: 1,
      groups: '[]',
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    const categoryIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const category = PlatformCategory.create({
        id: uuid7() as Id<'Category'>,
        revisionId: uuid7() as Id<'CategoryRevision'>,
        marketId: target.marketId,
        parentId: null,
        verticalRootCode: null,
        slug: `pp-${uuid7().slice(-10)}`,
        names: [{ locale: 'en-AU', name: `Category ${index}` }],
        createdByKind: 'seed',
        now: T0,
      });
      if (!category.ok) throw new Error(category.error.code);
      await run(target, () =>
        new PrismaPlatformCategoryRepository(db.service).add(target, category.value),
      );
      categoryIds.push(category.value.state.id);
    }
    const variantIds: string[] = [];
    const states: string[] = [];
    const variantFor = async (state: string): Promise<string> => {
      const variantId = uuid7();
      await insert('product_variants', {
        id: variantId,
        ...base,
        product_id: productId,
        variant_model: 'options',
        state: 'proposed',
        created_at: T0.toString(),
      });
      states.push(state);
      return variantId;
    };
    const revision = async (no: number, spec: Spec): Promise<string> => {
      const revisionId = uuid7();
      await insert('product_revisions', {
        id: revisionId,
        ...base,
        product_id: productId,
        revision_no: no,
        revision_kind: 'submission',
        base_revision_id: null,
        reverted_from_revision_id: null,
        family_revision_id: familyRevisionId,
        definition_revision_ids: [],
        tax_category_code: 'standard',
        attribute_values: '{}',
        field_provenance: null,
        sensitive: false,
        sensitive_reasons: [],
        content_schema_version: 1,
        content_hash: `sha256:${String(no).repeat(64)}`,
        author_kind: 'admin',
        author_account_id: uuid7(),
        acting_admin_account_id: null,
        submitted_at: T0.toString(),
      });
      for (const [locale, text] of Object.entries(spec.texts)) {
        await insert('product_revision_texts', {
          ...base,
          revision_id: revisionId,
          locale,
          name: text.name,
          short_description: text.shortDescription ?? null,
          description: text.description ?? null,
        });
      }
      // Position order is the reverse of the categories' creation order.
      for (const [index, categoryId] of [...categoryIds].reverse().entries()) {
        await insert('product_revision_categories', {
          ...base,
          revision_id: revisionId,
          category_id: categoryId,
          position: index,
        });
      }
      for (const [index, variant] of spec.variants.entries()) {
        if (variantIds.length <= index) variantIds.push(await variantFor(variant.state));
        await insert('product_revision_variants', {
          ...base,
          revision_id: revisionId,
          variant_id: variantIds[index],
          product_id: productId,
          position: index,
          option_key: `size=${index}`,
          option_values: `{"size":"${index}"}`,
          labels: JSON.stringify(variant.labels),
        });
      }
      return revisionId;
    };
    if (published !== null) {
      const revisionId = await revision(1, published);
      await owner.query(
        `UPDATE catalog.products SET status = 'published', published_revision_id = $3
           WHERE market_id = $1 AND id = $2`,
        [target.marketId, productId, revisionId],
      );
    }
    if (draft !== null) await revision(2, draft);
    // The registry state is set last: a revision cannot carry a retired variant.
    for (const [index, state] of states.entries()) {
      if (state === 'proposed') continue;
      await owner.query(
        `UPDATE catalog.product_variants
            SET state = $3, published_at = now(), retired_at = CASE WHEN $3 = 'retired' THEN now() END
          WHERE market_id = $1 AND id = $2`,
        [target.marketId, variantIds[index], state],
      );
    }
    return { productId, variantIds, categoryIds };
  }

  const read = (productId: Id<'Product'>, locales = LOCALES) =>
    run(market, () => reader.read(market, productId, locales), true);

  it('returns the published content, never a newer unpublished revision', async () => {
    const a = await product(
      market,
      {
        texts: { 'en-AU': { name: 'Dates', shortDescription: 'Sweet', description: 'Medjool' } },
        variants: [
          { state: 'published', labels: { 'en-AU': '500 g' } },
          { state: 'published', labels: { 'en-AU': '1 kg' } },
        ],
      },
      { texts: { 'en-AU': { name: 'DRAFT NAME' } }, variants: [] },
    );

    const answer = await read(a.productId);

    expect(answer).toEqual({
      productId: a.productId,
      publishedRevisionId: expect.any(String) as unknown,
      name: 'Dates',
      shortDescription: 'Sweet',
      description: 'Medjool',
      categoryIds: [...a.categoryIds].reverse(),
      variants: [
        { variantId: a.variantIds[0], position: 0, label: '500 g' },
        { variantId: a.variantIds[1], position: 1, label: '1 kg' },
      ],
      brand: null,
    });
    expect(JSON.stringify(answer)).not.toContain('DRAFT');
  });

  /** A brand row (brands are shared by every Market); `draft` needs the seller who proposed it. */
  async function brand(status: 'active' | 'draft', name: string): Promise<string> {
    const id = uuid7();
    const slug = `pp-${uuid7().slice(-12)}`;
    await insert('brands', {
      id,
      slug,
      name,
      name_key: slug.replaceAll('-', ''),
      status,
      ...(status === 'draft' ? { proposed_by_seller_id: uuid7() } : {}),
      created_at: T0.toString(),
      updated_at: T0.toString(),
      version: 1,
    });
    return slug;
  }
  const setBrand = (target: typeof market, productId: string, slug: string) =>
    owner.query(
      `UPDATE catalog.products SET brand_id = (SELECT id FROM catalog.brands WHERE slug = $3)
        WHERE market_id = $1 AND id = $2`,
      [target.marketId, productId, slug],
    );
  const SPEC: Spec = {
    texts: { 'en-AU': { name: 'Branded' } },
    variants: [{ state: 'published', labels: { 'en-AU': 'A' } }],
  };

  it("carries the product's active brand, and none for a draft brand or no brand", async () => {
    const withBrand = await product(market, SPEC);
    const withDraft = await product(market, SPEC);
    const plain = await product(market, SPEC);
    const active = await brand('active', 'Saffron & Co');
    const draft = await brand('draft', 'Not Yet');
    await setBrand(market, withBrand.productId, active);
    await setBrand(market, withDraft.productId, draft);

    expect((await read(withBrand.productId))?.brand).toEqual({
      slug: active,
      name: 'Saffron & Co',
    });
    expect((await read(withDraft.productId))?.brand).toBeNull();
    expect((await read(plain.productId))?.brand).toBeNull();
  });

  it('lists the live products of an active brand in this Market only (public brand ids)', async () => {
    const brands = new PrismaBrandReader(db.service);
    const live = await product(market, SPEC);
    const unlisted = await product(market, SPEC);
    const foreign = await product(other, SPEC);
    const slug = await brand('active', 'Live Brand');
    const draftSlug = await brand('draft', 'Draft Brand');
    await setBrand(market, live.productId, slug);
    await setBrand(market, unlisted.productId, slug);
    await setBrand(other, foreign.productId, slug);
    const offer = async (target: typeof market, productId: string, listed: boolean) => {
      await owner.query(
        `INSERT INTO catalog.offers (id, market_id, tenant_id, seller_id, product_id, seller_sku,
           condition_code, description, handling, attestation_recorded_at, attestation_account_id,
           status, off_sale_type_not_allowed, off_sale_product_retired, off_sale_product_not_listed,
           off_sale_tag_suspended, off_sale_description_claim_text, listed, submitted_at,
           first_published_at, version, created_at)
         VALUES ($1,$2,$3,$4,$5,'SKU-LIVE','new','{"en":"x"}','SEALED_ORIGINAL',$6,$7,'published',
           false,$8,false,false,false,$9,$6,$6,1,$6)`,
        [
          uuid7(),
          target.marketId,
          target.tenantId,
          uuid7(),
          productId,
          T0.toString(),
          uuid7(),
          !listed,
          listed,
        ],
      );
    };
    await offer(market, live.productId, true);
    await offer(market, unlisted.productId, false);
    await offer(other, foreign.productId, true);
    const ids = (target: typeof market, slugOf: string, limit = 10) =>
      run(target, () => brands.liveProductIds(target, slugOf, limit), true);

    expect(await ids(market, slug)).toEqual([live.productId]);
    expect(await ids(other, slug)).toEqual([foreign.productId]);
    expect(await ids(market, draftSlug)).toEqual([]);
    expect(await ids(market, 'no-such-brand')).toEqual([]);
  });

  it('leaves out a variant that is proposed or retired in the registry', async () => {
    const a = await product(market, {
      texts: { 'en-AU': { name: 'Mixed' } },
      variants: [
        { state: 'published', labels: { 'en-AU': 'A' } },
        { state: 'proposed', labels: { 'en-AU': 'B' } },
        { state: 'retired', labels: { 'en-AU': 'C' } },
        { state: 'published', labels: {} },
      ],
    });

    const answer = await read(a.productId);

    expect(answer?.variants).toEqual([
      { variantId: a.variantIds[0], position: 0, label: 'A' },
      { variantId: a.variantIds[3], position: 3, label: null },
    ]);
  });

  it('falls back to the default locale, then to the first locale, as one set of texts', async () => {
    const a = await product(market, {
      texts: {
        'ja-JP': { name: 'Fallback name', shortDescription: 'Fallback short' },
        zz: { name: 'Other name', shortDescription: 'Other short', description: 'Other long' },
      },
      variants: [{ state: 'published', labels: { zz: 'Z' } }],
    });
    const b = await product(market, {
      texts: { zz: { name: 'Only name' } },
      variants: [{ state: 'published', labels: {} }],
    });

    const viaDefault = await read(a.productId);
    const viaFirst = await read(b.productId);

    expect(viaDefault).toMatchObject({
      name: 'Fallback name',
      shortDescription: 'Fallback short',
      description: null,
    });
    expect(viaDefault?.variants[0]?.label).toBe('Z');
    expect(viaFirst).toMatchObject({ name: 'Only name', shortDescription: null });
  });

  it('answers null for a product with no published revision, however much draft content it has', async () => {
    const a = await product(market, null, {
      texts: { 'en-AU': { name: 'DRAFT ONLY' } },
      variants: [{ state: 'published', labels: { 'en-AU': 'x' } }],
    });

    expect(await read(a.productId)).toBeNull();
  });

  it('answers null for an unpublished product, an unknown id and a product of another Market (canary)', async () => {
    const spec: Spec = {
      texts: { 'en-AU': { name: 'CANARY' } },
      variants: [{ state: 'published', labels: { 'en-AU': 'CANARY' } }],
    };
    const foreign = await product(other, spec);
    const gone = await product(market, spec);
    await owner.query(
      `UPDATE catalog.products SET status = 'unpublished' WHERE market_id = $1 AND id = $2`,
      [market.marketId, gone.productId],
    );

    expect(await read(foreign.productId)).toBeNull();
    expect(await read(gone.productId)).toBeNull();
    expect(await read(uuid7() as Id<'Product'>)).toBeNull();
  });
});
