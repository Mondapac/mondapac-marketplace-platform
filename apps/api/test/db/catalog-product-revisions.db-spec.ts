import { randomUUID } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { ContentHash, Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { StoredRevision } from '../../src/modules/catalog/domain/stored-revision';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { reduceDatabaseError } from '../../src/platform/persistence/database-error';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Catalog slice 4c-5 on PostgreSQL (catalog data design 3.7 to 3.10), for both Market fixtures:
// the revision store round trip, the numbering, the Market and product boundaries, and the
// refusals the tables make (retired or foreign variant, repeated option key, images).

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const HASH = `sha256:${'a'.repeat(64)}` as ContentHash;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)(
  'catalog product revisions in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    let persistence: Persistence;
    let products: PrismaProductRepository;
    let revisions: PrismaProductRevisionRepository;
    let app: Client;

    beforeAll(async () => {
      persistence = createPersistence();
      products = new PrismaProductRepository(persistence.service);
      revisions = new PrismaProductRevisionRepository(persistence.service);
      app = new Client({ connectionString: testDatabaseUrl() });
      await app.connect();
    });
    afterAll(async () => {
      await app.end();
      await persistence.close();
    });

    const inUnit = <T>(target: typeof market, work: () => Promise<T>): Promise<T> =>
      persistence.unitOfWork
        .run(target, async () => ({ ok: true as const, value: await work() }))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });

    /** `sqlState constraint` of a refused statement (constraint is empty for a trigger). */
    const failure = async (work: Promise<unknown>): Promise<string> => {
      try {
        await work;
      } catch (error) {
        const reduced = reduceDatabaseError(error);
        return `${reduced?.sqlState ?? 'none'} ${reduced?.constraint ?? ''}`.trim();
      }
      throw new Error('expected the statement to fail');
    };

    async function insert(table: string, row: Record<string, unknown>) {
      const columns = Object.keys(row);
      await app.query(
        `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    }
    const base = { market_id: market.marketId, tenant_id: market.tenantId };

    async function familyRevision(): Promise<string> {
      const familyId = uuid7();
      const revisionId = uuid7();
      await insert('attribute_families', {
        id: familyId,
        ...base,
        code: `f-${randomUUID().slice(0, 10)}`,
        status: 'active',
        created_by_kind: 'seed',
        version: 1,
        created_at: T0.toString(),
      });
      await insert('attribute_family_revisions', {
        id: revisionId,
        ...base,
        family_id: familyId,
        revision_no: 1,
        groups: '[]',
        author_kind: 'seed',
        created_at: T0.toString(),
      });
      return revisionId;
    }

    async function category(): Promise<string> {
      await app.query(
        `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
       ON CONFLICT DO NOTHING`,
        [market.marketId, market.tenantId],
      );
      const id = uuid7();
      await insert('platform_categories', {
        id,
        ...base,
        slug: `s-${randomUUID().slice(0, 12)}`,
        parent_id: null,
        status: 'active',
        merged_into_id: null,
        vertical_root_code: null,
        created_by_kind: 'seed',
        version: 1,
        created_at: T0.toString(),
      });
      return id;
    }

    /** A stored Configurable draft with `count` proposed variants. */
    async function product(count: number): Promise<Product> {
      const created = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'PLATFORM',
        sellerId: null,
        handler: configurableProductType,
        familyCode: 'default',
        productCode: await inUnit(market, () => products.nextProductCode(market)),
        variantId: null,
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      for (let n = 0; n < count; n++) {
        const added = created.value.addVariant(uuid7() as Id<'Variant'>, 100, T0, 'admin');
        if (!added.ok) throw new Error(added.error.code);
      }
      await inUnit(market, () => products.add(market, created.value));
      return created.value;
    }

    function revision(
      p: Product,
      familyRevisionId: string,
      categoryId: string,
      overrides: Partial<StoredRevision> = {},
    ): StoredRevision {
      const [first, second] = p.state.variants;
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
          texts: {
            en: { name: 'Dates', shortDescription: 'Sweet', description: null },
            ar: { name: 'تمر', shortDescription: null, description: null },
          },
          categoryIds: [categoryId],
          taxCategoryCode: 'standard',
          attributeValues: { origin: 'AU' },
          variants: [
            {
              variantId: first!.id,
              position: 1,
              optionKey: 'size=l',
              optionValues: { size: 'l' },
              labels: { en: 'Large' },
            },
            {
              variantId: second!.id,
              position: 2,
              optionKey: 'size=s',
              optionValues: { size: 's' },
              labels: {},
            },
          ],
          imageIds: [],
          schemaRef: { familyRevisionId, definitionRevisionIds: [] },
          contentSchemaVersion: 1,
        },
        ...overrides,
      };
    }

    it('numbers revisions one after another per product', async () => {
      const p = await product(2);
      const f = await familyRevision();
      const c = await category();
      expect(await inUnit(market, () => revisions.nextRevisionNo(market, p.state.id))).toBe(1);
      await inUnit(market, () => revisions.add(market, revision(p, f, c)));
      expect(await inUnit(market, () => revisions.nextRevisionNo(market, p.state.id))).toBe(2);
      expect(await inUnit(other, () => revisions.nextRevisionNo(other, p.state.id))).toBe(1);
    });

    it('stores a revision with its texts, categories and variants and reads it back', async () => {
      const p = await product(2);
      const f = await familyRevision();
      const c = await category();
      const stored = revision(p, f, c);
      await inUnit(market, () => revisions.add(market, stored));

      const found = await inUnit(market, () => revisions.find(market, p.state.id, stored.id));
      expect(found).toEqual(stored);
    });

    it('does not find a revision of another product, another Market, or an unknown id', async () => {
      const p = await product(2);
      const q = await product(2);
      const f = await familyRevision();
      const c = await category();
      const stored = revision(p, f, c);
      await inUnit(market, () => revisions.add(market, stored));

      expect(await inUnit(market, () => revisions.find(market, q.state.id, stored.id))).toBeNull();
      expect(await inUnit(other, () => revisions.find(other, p.state.id, stored.id))).toBeNull();
      expect(
        await inUnit(market, () =>
          revisions.find(market, p.state.id, uuid7() as Id<'ProductRevision'>),
        ),
      ).toBeNull();
    });

    it('refuses a repeated option key, a foreign variant and a repeated revision number', async () => {
      const p = await product(2);
      const q = await product(1);
      const f = await familyRevision();
      const c = await category();
      const good = revision(p, f, c);
      const twin = {
        ...good.content,
        variants: good.content.variants.map((variant) => ({ ...variant, optionKey: 'size=l' })),
      };
      expect(
        await failure(
          inUnit(market, () => revisions.add(market, revision(p, f, c, { content: twin }))),
        ),
      ).toBe('23505 product_revision_variants_market_id_revision_id_option_key_key');

      const foreign = {
        ...good.content,
        variants: [{ ...good.content.variants[0]!, variantId: q.state.variants[0]!.id }],
      };
      expect(
        await failure(
          inUnit(market, () => revisions.add(market, revision(p, f, c, { content: foreign }))),
        ),
      ).toBe('23503 product_revision_variants_market_id_product_id_variant_id_fkey');

      await inUnit(market, () => revisions.add(market, good));
      expect(
        await failure(
          inUnit(market, () => revisions.add(market, revision(p, f, c, { revisionNo: 1 }))),
        ),
      ).toBe('23505 product_revisions_market_id_product_id_revision_no_key');
    });

    it('round-trips a revert, a tax override and an acting-as seller revision (M1)', async () => {
      const p = await product(2);
      const f = await familyRevision();
      const c = await category();
      const first = revision(p, f, c, { revisionNo: 1 });
      await inUnit(market, () => revisions.add(market, first));
      const override = revision(p, f, c, {
        revisionNo: 2,
        kind: 'tax-override',
        baseRevisionId: first.id,
        sensitive: true,
        sensitiveReasons: ['tax-category', 'name'],
        authorKind: 'admin',
        content: { ...first.content, taxCategoryCode: 'exempt' },
      });
      const revert = revision(p, f, c, {
        revisionNo: 3,
        kind: 'revert',
        baseRevisionId: override.id,
        revertedFromRevisionId: first.id,
        sensitive: false,
        sensitiveReasons: [],
      });
      const acting = revision(p, f, c, {
        revisionNo: 4,
        authorKind: 'seller',
        actingAdminAccountId: uuid7() as Id<'Account'>,
        content: {
          ...first.content,
          texts: { en: { name: 'Only', shortDescription: null, description: null } },
          attributeValues: {},
          schemaRef: { familyRevisionId: f, definitionRevisionIds: [uuid7(), uuid7()] },
        },
      });
      for (const stored of [override, revert, acting]) {
        await inUnit(market, () => revisions.add(market, stored));
        expect(await inUnit(market, () => revisions.find(market, p.state.id, stored.id))).toEqual(
          stored,
        );
      }
    });

    it('leaves nothing behind when a child insert is refused (M2)', async () => {
      const p = await product(2);
      const q = await product(1);
      const f = await familyRevision();
      const c = await category();
      const good = revision(p, f, c);
      const bad = {
        ...good,
        content: {
          ...good.content,
          variants: [{ ...good.content.variants[0]!, variantId: q.state.variants[0]!.id }],
        },
      };
      expect(await failure(inUnit(market, () => revisions.add(market, bad)))).toBe(
        '23503 product_revision_variants_market_id_product_id_variant_id_fkey',
      );
      expect(await inUnit(market, () => revisions.find(market, p.state.id, bad.id))).toBeNull();
      expect(await inUnit(market, () => revisions.nextRevisionNo(market, p.state.id))).toBe(1);
    });

    it('refuses a category of another Market (M3, AC 11)', async () => {
      const p = await product(2);
      const f = await familyRevision();
      const foreignCategory = uuid7();
      await app.query(
        `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
         ON CONFLICT DO NOTHING`,
        [other.marketId, other.tenantId],
      );
      await insert('platform_categories', {
        id: foreignCategory,
        market_id: other.marketId,
        tenant_id: other.tenantId,
        slug: `s-${randomUUID().slice(0, 12)}`,
        parent_id: null,
        status: 'active',
        merged_into_id: null,
        vertical_root_code: null,
        created_by_kind: 'seed',
        version: 1,
        created_at: T0.toString(),
      });
      const stored = revision(p, f, foreignCategory);
      expect(await failure(inUnit(market, () => revisions.add(market, stored)))).toMatch(/^23503 /);
      expect(await inUnit(market, () => revisions.find(market, p.state.id, stored.id))).toBeNull();
    });

    it('lets one of two concurrent adds win and fails the other on the unique number (M4)', async () => {
      const p = await product(2);
      const f = await familyRevision();
      const c = await category();
      const number = await inUnit(market, () => revisions.nextRevisionNo(market, p.state.id));
      const results = await Promise.allSettled([
        inUnit(market, () => revisions.add(market, revision(p, f, c, { revisionNo: number }))),
        inUnit(market, () => revisions.add(market, revision(p, f, c, { revisionNo: number }))),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await inUnit(market, () => revisions.nextRevisionNo(market, p.state.id))).toBe(
        number + 1,
      );
    });

    it('reads categories and variants back in position order whatever the insert order (L4)', async () => {
      const p = await product(2);
      const f = await familyRevision();
      const c1 = await category();
      const c2 = await category();
      const stored = revision(p, f, c1);
      const reversed = {
        ...stored,
        content: {
          ...stored.content,
          categoryIds: [c2, c1],
          variants: [...stored.content.variants].reverse(),
        },
      };
      await inUnit(market, () => revisions.add(market, reversed));
      const found = await inUnit(market, () => revisions.find(market, p.state.id, stored.id));
      expect(found?.content.categoryIds).toEqual([c2, c1]);
      expect(found?.content.variants.map((variant) => variant.position)).toEqual([1, 2]);
    });

    it('refuses a retired variant in a new revision', async () => {
      const p = await product(2);
      const f = await familyRevision();
      const c = await category();
      const stored = (await inUnit(market, () => products.findById(market, p.state.id)))!;
      const removed = stored.removeProposedVariant(p.state.variants[1]!.id, T0, 'admin');
      expect(removed.ok).toBe(true);
      await inUnit(market, () => products.save(market, stored));
      expect(await failure(inUnit(market, () => revisions.add(market, revision(p, f, c))))).toBe(
        '23514',
      );
    });

    it('refuses images until the image slice exists', async () => {
      const p = await product(2);
      const f = await familyRevision();
      const c = await category();
      const stored = revision(p, f, c);
      await expect(
        inUnit(market, () =>
          revisions.add(market, {
            ...stored,
            content: { ...stored.content, imageIds: [uuid7()] },
          }),
        ),
      ).rejects.toThrow(/slice 13/);
    });
  },
);
