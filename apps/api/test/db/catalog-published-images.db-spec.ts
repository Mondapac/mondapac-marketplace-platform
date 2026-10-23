import { createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaPublishedImagesReader } from '../../src/modules/catalog/infrastructure/prisma-published-images.reader';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The buyer-facing photo reads on PostgreSQL, for both Market fixtures: only photos of the
// CURRENT PUBLISHED revision of a PUBLISHED product that are not taken down, in revision order and
// at most the asked number, the rendition key of a public photo only, and the Market boundary
// (canary). A draft or pending-only photo, a photo of an older revision, a taken-down photo, an
// unpublished product and another Market's photo are never answered.

const T0 = Temporal.Instant.from('2026-10-21T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog published images in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let reader: PrismaPublishedImagesReader;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    reader = new PrismaPublishedImagesReader(db.service);
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

  interface Photo {
    readonly id: string;
    readonly width: number;
    readonly height: number;
  }
  interface Made {
    readonly productId: Id<'Product'>;
    readonly publishedRevisionId: string | null;
    readonly revisions: string[];
    /** A photo uploaded to the product's library: in no revision until `attach`. */
    photo(width?: number, height?: number): Promise<Photo>;
    attach(revisionNo: number, ...photos: Photo[]): Promise<void>;
    takeDown(photo: Photo): Promise<void>;
  }

  /** A product with `revisionCount` revisions; the `published`-th one (if any) is published. */
  async function product(
    target: typeof market,
    options: { revisionCount: number; published: number | null },
  ): Promise<Made> {
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
    const revisions: string[] = [];
    for (let no = 1; no <= options.revisionCount; no++) {
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
      revisions.push(revisionId);
    }
    const publishedRevisionId =
      options.published === null ? null : (revisions[options.published - 1] ?? null);
    if (publishedRevisionId !== null) {
      await owner.query(
        `UPDATE catalog.products SET status = 'published', published_revision_id = $3
           WHERE market_id = $1 AND id = $2`,
        [target.marketId, productId, publishedRevisionId],
      );
    }
    return {
      productId,
      publishedRevisionId,
      revisions,
      async photo(width = 1600, height = 1200): Promise<Photo> {
        const id = uuid7();
        await insert('product_images', {
          ...base,
          id,
          product_id: productId,
          uploader_account_id: uuid7(),
          state: 'clean',
          pixel_width: width,
          pixel_height: height,
          byte_size: 1234,
          created_at: T0.toString(),
        });
        for (const size of ['thumb', 'medium', 'large']) {
          await insert('product_image_renditions', {
            ...base,
            image_id: id,
            product_id: productId,
            size_code: size,
            object_key: `${productId}/${id}-${size}`,
            sha256: createHash('sha256').update(`${id}${size}`).digest(),
            byte_size: 99,
            pixel_width: width,
            pixel_height: height,
          });
        }
        return { id, width, height };
      },
      async attach(revisionNo: number, ...photos: Photo[]): Promise<void> {
        for (const [index, photo] of photos.entries()) {
          await insert('product_revision_images', {
            ...base,
            revision_id: revisions[revisionNo - 1],
            product_id: productId,
            image_id: photo.id,
            position: index + 1,
          });
        }
      },
      async takeDown(photo: Photo): Promise<void> {
        await owner.query(
          `UPDATE catalog.product_images
              SET state = 'taken-down', taken_down_at = now(),
                  taken_down_by_account_id = $3, takedown_reason_code = 'misleading'
            WHERE market_id = $1 AND id = $2`,
          [target.marketId, photo.id, uuid7()],
        );
      },
    };
  }

  const imagesOf = (productIds: Id<'Product'>[], perProduct = 8, target = market) =>
    run(target, () => reader.imagesOf(target, productIds, perProduct), true);
  const keyOf = (
    made: Made,
    photo: Photo,
    size: 'thumb' | 'medium' | 'large' = 'medium',
    target = market,
    productId: Id<'Product'> = made.productId,
  ) =>
    run(
      target,
      () => reader.renditionKey(target, productId, photo.id as Id<'ProductImage'>, size),
      true,
    );
  const shape = (photos: Photo[]) =>
    photos.map(({ id, width, height }) => ({ imageId: id, width, height }));

  describe('imagesOf', () => {
    it("lists the published revision's photos in revision order, with their pixel sizes", async () => {
      const made = await product(market, { revisionCount: 1, published: 1 });
      const [a, b, c] = [
        await made.photo(1600, 1200),
        await made.photo(800, 800),
        await made.photo(640, 480),
      ] as [Photo, Photo, Photo];
      await made.attach(1, c, a, b);

      const answer = await imagesOf([made.productId]);

      expect(answer.get(made.productId)).toEqual(shape([c, a, b]));
    });

    it('answers many products at once and caps each at the asked number', async () => {
      const one = await product(market, { revisionCount: 1, published: 1 });
      const two = await product(market, { revisionCount: 1, published: 1 });
      const none = await product(market, { revisionCount: 1, published: 1 });
      const photos = [await one.photo(), await one.photo(), await one.photo()];
      await one.attach(1, ...photos);
      const second = await two.photo(500, 500);
      await two.attach(1, second);

      const answer = await imagesOf([one.productId, two.productId, none.productId], 2);

      expect(answer.get(one.productId)).toEqual(shape(photos.slice(0, 2)));
      expect(answer.get(two.productId)).toEqual(shape([second]));
      expect(answer.has(none.productId)).toBe(false);
    });

    it('never answers a photo that only a newer, unpublished revision holds', async () => {
      const made = await product(market, { revisionCount: 2, published: 1 });
      const live = await made.photo();
      const pendingOnly = await made.photo();
      await made.attach(1, live);
      await made.attach(2, live, pendingOnly);

      const answer = await imagesOf([made.productId]);

      expect(answer.get(made.productId)).toEqual(shape([live]));
    });

    it('never answers a photo of an older revision once a newer one is published', async () => {
      const made = await product(market, { revisionCount: 2, published: 2 });
      const old = await made.photo();
      const current = await made.photo();
      await made.attach(1, old);
      await made.attach(2, current);

      const answer = await imagesOf([made.productId]);

      expect(answer.get(made.productId)).toEqual(shape([current]));
    });

    it('never answers a photo in the library that no revision holds', async () => {
      const made = await product(market, { revisionCount: 1, published: 1 });
      await made.photo();

      expect((await imagesOf([made.productId])).size).toBe(0);
    });

    it('skips a taken-down photo and keeps the rest in order', async () => {
      const made = await product(market, { revisionCount: 1, published: 1 });
      const [a, b, c] = [await made.photo(), await made.photo(), await made.photo()] as [
        Photo,
        Photo,
        Photo,
      ];
      await made.attach(1, a, b, c);
      await made.takeDown(a);

      const answer = await imagesOf([made.productId]);

      expect(answer.get(made.productId)).toEqual(shape([b, c]));
    });

    it('answers nothing for a product that is not published, however many photos it holds', async () => {
      const draft = await product(market, { revisionCount: 1, published: null });
      const gone = await product(market, { revisionCount: 1, published: 1 });
      for (const made of [draft, gone]) {
        const photo = await made.photo();
        await made.attach(1, photo);
      }
      await owner.query(
        `UPDATE catalog.products SET status = 'unpublished' WHERE market_id = $1 AND id = $2`,
        [market.marketId, gone.productId],
      );

      expect((await imagesOf([draft.productId, gone.productId])).size).toBe(0);
      expect((await imagesOf([uuid7() as Id<'Product'>])).size).toBe(0);
      expect((await imagesOf([])).size).toBe(0);
    });

    it("never answers another Market's product or photo (canary)", async () => {
      const foreign = await product(other, { revisionCount: 1, published: 1 });
      const photo = await foreign.photo();
      await foreign.attach(1, photo);

      expect((await imagesOf([foreign.productId])).size).toBe(0);
      expect((await imagesOf([foreign.productId], 8, other)).get(foreign.productId)).toEqual(
        shape([photo]),
      );
    });
  });

  describe('renditionKey', () => {
    it('gives the stored key of each rendition of a public photo', async () => {
      const made = await product(market, { revisionCount: 1, published: 1 });
      const photo = await made.photo();
      await made.attach(1, photo);

      for (const size of ['thumb', 'medium', 'large'] as const) {
        expect(await keyOf(made, photo, size)).toBe(`${made.productId}/${photo.id}-${size}`);
      }
    });

    it('is null for a photo that only a draft or pending revision holds, or that no revision holds', async () => {
      const made = await product(market, { revisionCount: 2, published: 1 });
      const pendingOnly = await made.photo();
      const unattached = await made.photo();
      await made.attach(2, pendingOnly);

      expect(await keyOf(made, pendingOnly)).toBeNull();
      expect(await keyOf(made, unattached)).toBeNull();
    });

    it('is null for a photo of an older revision', async () => {
      const made = await product(market, { revisionCount: 2, published: 2 });
      const old = await made.photo();
      await made.attach(1, old);

      expect(await keyOf(made, old)).toBeNull();
    });

    it('is null for a taken-down photo, and a takedown takes effect on the next read', async () => {
      const made = await product(market, { revisionCount: 1, published: 1 });
      const photo = await made.photo();
      await made.attach(1, photo);
      expect(await keyOf(made, photo)).not.toBeNull();

      await made.takeDown(photo);

      expect(await keyOf(made, photo)).toBeNull();
    });

    it('is null for an unpublished product, an unknown id and a photo asked under another product', async () => {
      const draft = await product(market, { revisionCount: 1, published: null });
      const draftPhoto = await draft.photo();
      await draft.attach(1, draftPhoto);
      const live = await product(market, { revisionCount: 1, published: 1 });
      const livePhoto = await live.photo();
      await live.attach(1, livePhoto);

      expect(await keyOf(draft, draftPhoto)).toBeNull();
      expect(await keyOf(live, { id: uuid7(), width: 1, height: 1 })).toBeNull();
      expect(await keyOf(live, livePhoto, 'medium', market, draft.productId)).toBeNull();
    });

    it('is null from another Market, even with the same ids (canary)', async () => {
      const foreign = await product(other, { revisionCount: 1, published: 1 });
      const photo = await foreign.photo();
      await foreign.attach(1, photo);

      expect(await keyOf(foreign, photo)).toBeNull();
      expect(await keyOf(foreign, photo, 'medium', other)).not.toBeNull();
    });
  });
});
