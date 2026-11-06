import { randomUUID, createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { ContentHash, Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { StoredRevision } from '../../src/modules/catalog/domain/stored-revision';
import type { RevisionVariantContent } from '../../src/modules/catalog/domain/revision-content';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { PrismaPublishedProductReader } from '../../src/modules/catalog/infrastructure/prisma-published-product.reader';
import { PrismaVariantGtinRegistry } from '../../src/modules/catalog/infrastructure/prisma-variant-gtin.registry';
import { reduceDatabaseError } from '../../src/platform/persistence/database-error';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Variants management V4 on PostgreSQL, for both Market fixtures: the per-variant GTIN, shipping
// values and image picks round-trip; the table refuses a bad GTIN, a half-set box and a pick
// outside the revision's gallery; the duplicate-GTIN lookup counts only the published revision of
// a published product, only not-retired variants, never the asking product or another Market; and
// the published-product facade returns the fields.

const T0 = Temporal.Instant.from('2026-11-04T00:00:00Z');
const HASH = `sha256:${'b'.repeat(64)}` as ContentHash;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
/** A valid GTIN-14 no other test uses (the database is shared by the tests of one run). */
let gtinSeq = 100000;
function freshGtin(): string {
  const body = `0400${String(gtinSeq++).padStart(9, '0')}`;
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    sum += Number(body[index]) * ((body.length - index) % 2 === 1 ? 3 : 1);
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

describe.each(TEST_MARKETS)('catalog variant fields in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let revisions: PrismaProductRevisionRepository;
  let registry: PrismaVariantGtinRegistry;
  let reader: PrismaPublishedProductReader;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    revisions = new PrismaProductRevisionRepository(db.service);
    registry = new PrismaVariantGtinRegistry(db.service);
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
  const failure = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
    } catch (error) {
      const reduced = reduceDatabaseError(error);
      return `${reduced?.sqlState ?? 'none'} ${reduced?.constraint ?? ''}`.trim();
    }
    throw new Error('expected the statement to fail');
  };
  async function insert(table: string, row: Record<string, unknown>, target = market) {
    const columns = Object.keys(row);
    await owner.query(
      `INSERT INTO catalog.${table} (market_id, tenant_id, ${columns.join(', ')})
       VALUES ($${columns.length + 1}, $${columns.length + 2}, ${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      [...Object.values(row), target.marketId, target.tenantId],
    );
  }

  async function familyRevision(target = market): Promise<string> {
    const familyId = uuid7();
    const revisionId = uuid7();
    await insert(
      'attribute_families',
      {
        id: familyId,
        code: `f-${randomUUID().slice(0, 10)}`,
        status: 'active',
        created_by_kind: 'seed',
        version: 1,
        created_at: T0.toString(),
      },
      target,
    );
    await insert(
      'attribute_family_revisions',
      {
        id: revisionId,
        family_id: familyId,
        revision_no: 1,
        groups: '[]',
        author_kind: 'seed',
        created_at: T0.toString(),
      },
      target,
    );
    return revisionId;
  }

  async function category(target = market): Promise<string> {
    await owner.query(
      `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
       ON CONFLICT DO NOTHING`,
      [target.marketId, target.tenantId],
    );
    const id = uuid7();
    await insert(
      'platform_categories',
      {
        id,
        slug: `s-${randomUUID().slice(0, 12)}`,
        parent_id: null,
        status: 'active',
        merged_into_id: null,
        vertical_root_code: null,
        created_by_kind: 'seed',
        version: 1,
        created_at: T0.toString(),
      },
      target,
    );
    return id;
  }

  async function product(count: number, target = market): Promise<Product> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: configurableProductType,
      familyCode: 'default',
      productCode: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      variantId: null,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    for (let n = 0; n < count; n++) {
      const added = created.value.addVariant(uuid7() as Id<'Variant'>, 100, T0, 'admin');
      if (!added.ok) throw new Error(added.error.code);
    }
    await run(target, () => products.add(target, created.value));
    return created.value;
  }

  async function photo(productId: string, target = market): Promise<string> {
    const id = uuid7();
    await insert(
      'product_images',
      {
        id,
        product_id: productId,
        uploader_account_id: uuid7(),
        state: 'clean',
        pixel_width: 1600,
        pixel_height: 1200,
        byte_size: 1234,
        created_at: T0.toString(),
      },
      target,
    );
    for (const size of ['thumb', 'medium', 'large']) {
      await insert(
        'product_image_renditions',
        {
          image_id: id,
          product_id: productId,
          size_code: size,
          object_key: `${productId}/${id}-${size}`,
          sha256: createHash('sha256').update(`${id}${size}`).digest(),
          byte_size: 99,
          pixel_width: 1600,
          pixel_height: 1200,
        },
        target,
      );
    }
    return id;
  }

  const empty = {
    gtin: null,
    shippingWeightGrams: null,
    shippingLengthMm: null,
    shippingWidthMm: null,
    shippingHeightMm: null,
    imageIds: [] as string[],
  };

  function revision(
    p: Product,
    familyRevisionId: string,
    categoryId: string,
    variants: Partial<RevisionVariantContent>[],
    imageIds: string[] = [],
  ): StoredRevision {
    return {
      id: uuid7() as Id<'ProductRevision'>,
      productId: p.state.id,
      revisionNo: 1,
      kind: 'submission',
      baseRevisionId: null,
      revertedFromRevisionId: null,
      sensitive: true,
      sensitiveReasons: ['never-published'],
      contentHash: HASH,
      authorKind: 'admin',
      authorAccountId: uuid7() as Id<'Account'>,
      actingAdminAccountId: null,
      submittedAt: T0,
      content: {
        texts: { en: { name: 'Dates', shortDescription: null, description: null } },
        categoryIds: [categoryId],
        taxCategoryCode: 'standard',
        attributeValues: {},
        variants: variants.map((fields, index) => ({
          variantId: p.state.variants[index]!.id,
          position: index + 1,
          optionKey: `size=${index}`,
          optionValues: { size: String(index) },
          labels: { en: `Size ${index}` },
          ...empty,
          ...fields,
        })),
        imageIds,
        schemaRef: { familyRevisionId, definitionRevisionIds: [] },
        contentSchemaVersion: 1,
      },
    };
  }

  /** A product whose one revision is published; `variantFields` per variant. */
  async function published(
    variantFields: Partial<RevisionVariantContent>[],
    pickFrom = 0,
    target = market,
  ) {
    const p = await product(variantFields.length, target);
    const f = await familyRevision(target);
    const c = await category(target);
    const gallery = await Promise.all(
      Array.from({ length: pickFrom }, () => photo(p.state.id, target)),
    );
    const fields = variantFields.map((entry) => ({
      ...entry,
      imageIds: (entry.imageIds ?? []).map((index) => gallery[Number(index)]!),
    }));
    const stored = revision(p, f, c, fields, gallery);
    await run(target, () => revisions.add(target, stored));
    await owner.query(
      `UPDATE catalog.products SET status = 'published', published_revision_id = $3
        WHERE market_id = $1 AND id = $2`,
      [target.marketId, p.state.id, stored.id],
    );
    return { p, stored, gallery };
  }

  const setVariantState = (target: typeof market, variantId: string, state: string) =>
    owner.query(
      `UPDATE catalog.product_variants
          SET state = $3, published_at = now(), retired_at = CASE WHEN $3 = 'retired' THEN now() END
        WHERE market_id = $1 AND id = $2`,
      [target.marketId, variantId, state],
    );

  it('stores a GTIN, shipping values and ordered picks and reads them back', async () => {
    const GTIN = freshGtin();
    const p = await product(2);
    const f = await familyRevision();
    const c = await category();
    const gallery = [await photo(p.state.id), await photo(p.state.id), await photo(p.state.id)];
    const stored = revision(
      p,
      f,
      c,
      [
        {
          gtin: GTIN,
          shippingWeightGrams: 450,
          shippingLengthMm: 200,
          shippingWidthMm: 100,
          shippingHeightMm: 50,
          imageIds: [gallery[2]!, gallery[0]!],
        },
        {},
      ],
      gallery,
    );
    await run(market, () => revisions.add(market, stored));
    const found = await run(market, () => revisions.find(market, p.state.id, stored.id));
    expect(found).toEqual(stored);
    expect(found?.content.variants[0]?.imageIds).toEqual([gallery[2], gallery[0]]);
  });

  it('refuses a malformed GTIN, a half-set box and a weight out of range', async () => {
    const p = await product(1);
    const f = await familyRevision();
    const c = await category();
    const add = (fields: Partial<RevisionVariantContent>) =>
      run(market, () => revisions.add(market, revision(p, f, c, [fields])));
    expect(await failure(add({ gtin: '4006381333931' }))).toBe(
      '23514 product_revision_variants_gtin_check',
    );
    expect(await failure(add({ shippingLengthMm: 10 }))).toBe(
      '23514 product_revision_variants_dimensions_check',
    );
    expect(await failure(add({ shippingWeightGrams: 0 }))).toBe(
      '23514 product_revision_variants_weight_check',
    );
    expect(await failure(add({ shippingWeightGrams: 1_000_001 }))).toBe(
      '23514 product_revision_variants_weight_check',
    );
  });

  it('refuses a pick outside the revision gallery and a repeated pick', async () => {
    const p = await product(1);
    const f = await familyRevision();
    const c = await category();
    const inGallery = await photo(p.state.id);
    const outside = await photo(p.state.id);
    expect(
      await failure(
        run(market, () =>
          revisions.add(market, revision(p, f, c, [{ imageIds: [outside] }], [inGallery])),
        ),
      ),
    ).toMatch(/^23514/);
    expect(
      await failure(
        run(market, () =>
          revisions.add(
            market,
            revision(p, f, c, [{ imageIds: [inGallery, inGallery] }], [inGallery]),
          ),
        ),
      ),
    ).toMatch(/^23514/);
  });

  describe('duplicate GTIN lookup', () => {
    it('finds a published PLATFORM product by its public code, in any other product', async () => {
      const GTIN = freshGtin();
      const mine = await published([{ gtin: GTIN }]);
      const asking = await product(1);
      const found = await run(
        market,
        () => registry.duplicatesOf(market, asking.state.id, [GTIN, freshGtin()]),
        true,
      );
      expect(found).toEqual([
        { gtin: GTIN, scope: 'PLATFORM', platformProductCode: mine.p.state.productCode },
      ]);
    });

    it('never matches the asking product itself, another Market, or an unknown GTIN', async () => {
      const [mineG, foreignG, unknownG] = [freshGtin(), freshGtin(), freshGtin()];
      const own = await published([{ gtin: mineG }]);
      expect(
        await run(market, () => registry.duplicatesOf(market, own.p.state.id, [mineG]), true),
      ).toEqual([]);
      const asking = await product(1);
      expect(
        await run(market, () => registry.duplicatesOf(market, asking.state.id, [unknownG]), true),
      ).toEqual([]);
      const foreign = await published([{ gtin: foreignG }], 0, other);
      void foreign;
      expect(
        await run(market, () => registry.duplicatesOf(market, asking.state.id, [foreignG]), true),
      ).toEqual([]);
    });

    it('ignores a revision that is not the published one, an unpublished product and a retired variant', async () => {
      const [storedG, retiredG, unpublishedG] = [freshGtin(), freshGtin(), freshGtin()];
      const asking = await product(1);
      // A revision that was stored but is not the published pointer.
      const p = await product(1);
      const f = await familyRevision();
      const c = await category();
      await run(market, () => revisions.add(market, revision(p, f, c, [{ gtin: storedG }])));
      expect(
        await run(market, () => registry.duplicatesOf(market, asking.state.id, [storedG]), true),
      ).toEqual([]);

      const live = await published([{ gtin: retiredG }]);
      await setVariantState(market, live.p.state.variants[0]!.id, 'retired');
      expect(
        await run(market, () => registry.duplicatesOf(market, asking.state.id, [retiredG]), true),
      ).toEqual([]);

      const draft = await published([{ gtin: unpublishedG }]);
      await owner.query(
        `UPDATE catalog.products SET status = 'unpublished'
          WHERE market_id = $1 AND id = $2`,
        [market.marketId, draft.p.state.id],
      );
      expect(
        await run(
          market,
          () => registry.duplicatesOf(market, asking.state.id, [unpublishedG]),
          true,
        ),
      ).toEqual([]);
    });
  });

  it('returns the fields on the published product facade', async () => {
    const GTIN = freshGtin();
    const live = await published(
      [
        {
          gtin: GTIN,
          shippingWeightGrams: 300,
          shippingLengthMm: 10,
          shippingWidthMm: 20,
          shippingHeightMm: 30,
          imageIds: ['1'],
        },
        {},
      ],
      2,
    );
    for (const variant of live.p.state.variants) {
      await setVariantState(market, variant.id, 'published');
    }
    const answer = await run(
      market,
      () => reader.read(market, live.p.state.id, { requested: 'en', fallback: 'en' }),
      true,
    );
    expect(answer?.variants[0]).toMatchObject({
      gtin: GTIN,
      imageIds: [live.gallery[1]],
      shipping: { weightGrams: 300, lengthMm: 10, widthMm: 20, heightMm: 30 },
    });
    expect(answer?.variants[1]).toMatchObject({
      gtin: null,
      imageIds: [],
      shipping: { weightGrams: null, lengthMm: null, widthMm: null, heightMm: null },
    });
  });
});
