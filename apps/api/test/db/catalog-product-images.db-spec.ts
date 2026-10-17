import { randomUUID } from 'node:crypto';
import { Temporal, ok, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import type { PendingEvent } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import sharp from 'sharp';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { MemoryObjectStore } from '../../src/platform/storage/disk-object-store';
import { CheckClaimText } from '../../src/modules/catalog/application/claim-text/check-claim-text.service';
import { MAX_IMAGES_PER_PRODUCT } from '../../src/modules/catalog/application/images/image-limits';
import type { AttributeRepository } from '../../src/modules/catalog/application/ports/attribute.repository';
import type { CatalogMarketPolicy } from '../../src/modules/catalog/application/ports/catalog-market-policy';
import { FreezeRevision } from '../../src/modules/catalog/application/revisions/freeze-revision.service';
import { SubmitProduct } from '../../src/modules/catalog/application/revisions/submit-product.service';
import { OwnProductImageDelete } from '../../src/modules/catalog/application/use-cases/own-product-image-delete.use-case';
import { OwnProductImageList } from '../../src/modules/catalog/application/use-cases/own-product-image-list.use-case';
import { OwnProductImageRead } from '../../src/modules/catalog/application/use-cases/own-product-image-read.use-case';
import { ProductImageAdminRead } from '../../src/modules/catalog/application/use-cases/product-image-admin-read.use-case';
import { ProductImageTakeDown } from '../../src/modules/catalog/application/use-cases/product-image-take-down.use-case';
import { ProductRevisionImageList } from '../../src/modules/catalog/application/use-cases/product-revision-image-list.use-case';
import { SweepOrphanImages } from '../../src/modules/catalog/application/use-cases/sweep-orphan-images.use-case';
import { OwnProductImageUpload } from '../../src/modules/catalog/application/use-cases/own-product-image-upload.use-case';
import type { SaveWorkingCopy } from '../../src/modules/catalog/application/working-copy/save-working-copy.service';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { HmacRateCounterKeys } from '../../src/modules/catalog/infrastructure/hmac-rate-counter-keys';
import { PrismaProductImageRepository } from '../../src/modules/catalog/infrastructure/prisma-product-image.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { PrismaWorkingCopyRepository } from '../../src/modules/catalog/infrastructure/prisma-working-copy.repository';
import { SharpImageProcessor } from '../../src/modules/catalog/infrastructure/sharp-image-processor';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Catalog slice 13 (product photos) on PostgreSQL, for both Market fixtures: upload, list, read
// and delete as a seller over the real stores and the real image library, and the photos of a
// submitted revision (ordered rows, the in-use refusal, the freeze check).

const T0 = Temporal.Instant.from('2026-10-14T00:00:00Z');
const clock = new FixedClock(T0);
let sequence = 0;
const SELLER = '01990000-0000-7000-8000-00000000c001' as Id<'Seller'>;
const OTHER = '01990000-0000-7000-8000-00000000c002' as Id<'Seller'>;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

const photo = async (
  width = 600,
  height = 400,
  format: 'jpeg' | 'png' | 'webp' | 'gif' = 'jpeg',
): Promise<string> => {
  const raw = sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 60, b: 60, alpha: 0.5 } },
  });
  const bytes =
    format === 'jpeg'
      ? await raw.jpeg().toBuffer()
      : format === 'png'
        ? await raw.png().toBuffer()
        : format === 'webp'
          ? await raw.webp().toBuffer()
          : await raw.gif().toBuffer();
  return bytes.toString('base64');
};

describe.each(TEST_MARKETS)(
  'catalog product images in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let app: Client;
    let products: PrismaProductRepository;
    let copies: PrismaWorkingCopyRepository;
    let images: PrismaProductImageRepository;
    let store: MemoryObjectStore;
    let throttled: boolean;
    let upload: OwnProductImageUpload;
    let list: OwnProductImageList;
    let read: OwnProductImageRead;
    let remove: OwnProductImageDelete;
    let submit: SubmitProduct;
    let takeDown: ProductImageTakeDown;
    let adminRead: ProductImageAdminRead;
    let revisionImages: ProductRevisionImageList;
    let sweepLater: SweepOrphanImages;
    let sweepNow: SweepOrphanImages;
    let events: PendingEvent[];
    let revisions: PrismaProductRevisionRepository;
    let categoryId: string;

    const policy: CatalogMarketPolicy = {
      taxCategoryCodes: () => ['t1'],
      locales: () => ({ default: 'en', supported: ['en'] }),
      sensitiveChanges: () => ({
        platformCategories: true,
        taxCategory: true,
        name: true,
        primaryImage: true,
        anyImage: false,
        variantRemoved: true,
      }),
      maxVariantsPerProduct: () => 10,
      productTypes: () => ['simple', 'configurable'],
      defaultFamily: () => 'default',
      conditions: () => ['new'],
      sellFromCatalogue: () => Promise.resolve(true),
      sellerCanCreateProduct: () => Promise.resolve(true),
      approvalRequired: () => Promise.resolve(true),
    };
    const base = { market_id: market.marketId, tenant_id: market.tenantId };
    async function insert(table: string, row: Record<string, unknown>) {
      const columns = Object.keys(row);
      await app.query(
        `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    }

    beforeAll(async () => {
      persistence = createPersistence();
      app = new Client({ connectionString: testDatabaseUrl() });
      await app.connect();
      products = new PrismaProductRepository(persistence.service);
      copies = new PrismaWorkingCopyRepository(persistence.service);
      revisions = new PrismaProductRevisionRepository(persistence.service);
      images = new PrismaProductImageRepository(persistence.service);
      store = new MemoryObjectStore();

      const familyId = uuid7();
      const familyRevisionId = uuid7();
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
        id: familyRevisionId,
        ...base,
        family_id: familyId,
        revision_no: 1,
        groups: '[]',
        author_kind: 'seed',
        created_at: T0.toString(),
      });
      await app.query(
        `INSERT INTO catalog.category_trees (market_id, tenant_id, version) VALUES ($1, $2, 1)
       ON CONFLICT DO NOTHING`,
        [market.marketId, market.tenantId],
      );
      categoryId = uuid7();
      await insert('platform_categories', {
        id: categoryId,
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

      const attributes = {
        loadSchema: () =>
          Promise.resolve({
            schemaRef: { familyCode: 'default', familyRevisionId, definitionRevisionIds: [] },
            fields: [],
          }),
      } as unknown as AttributeRepository;
      const check = new CheckClaimText({
        unitOfWork: persistence.unitOfWork,
        matcher: {
          match: (_context: unknown, texts: readonly unknown[]) =>
            Promise.resolve(ok(texts.map(() => []))),
        },
        counters: {
          reserve: () => Promise.reject(new Error('no counter')),
          purgeStartedBefore: () => Promise.resolve(0),
        },
        counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(5)),
        policy,
        clock,
      });
      submit = new SubmitProduct({
        unitOfWork: persistence.unitOfWork,
        products,
        workingCopies: copies,
        revisions,
        freeze: new FreezeRevision({
          attributes,
          policy,
          images,
          handlerFor: (typeCode) => (typeCode === 'simple' ? simpleProductType : undefined),
        }),
        check,
        policy,
        outbox: { append: () => Promise.resolve() },
        clock,
        ids: { next: <K extends string>() => uuid7() as Id<K> },
      });

      const save = {
        reserveSaves: () =>
          Promise.resolve(
            throttled ? { code: 'request.throttled' as const, retryAfterSeconds: 9 } : null,
          ),
      } as unknown as SaveWorkingCopy;
      const common = { unitOfWork: persistence.unitOfWork, products, images, objectStore: store };
      upload = new OwnProductImageUpload(gate, {
        ...common,
        imageProcessor: new SharpImageProcessor(),
        eligibility: { isEligible: () => Promise.resolve(true) },
        save,
        clock,
        ids: { next: <K extends string>() => uuid7() as Id<K> },
      });
      list = new OwnProductImageList(gate, {
        unitOfWork: persistence.unitOfWork,
        products,
        images,
      });
      read = new OwnProductImageRead(gate, common);
      remove = new OwnProductImageDelete(gate, common);
      events = [];
      takeDown = new ProductImageTakeDown(gate, {
        unitOfWork: persistence.unitOfWork,
        images,
        objectStore: store,
        outbox: {
          append: (_context, pending) => {
            events.push(...pending);
            return Promise.resolve();
          },
        },
        clock,
      });
      adminRead = new ProductImageAdminRead(gate, common);
      revisionImages = new ProductRevisionImageList(gate, {
        unitOfWork: persistence.unitOfWork,
        revisions,
        images,
      });
      const sweepWith = (at: Temporal.Instant) =>
        new SweepOrphanImages(gate, {
          unitOfWork: persistence.unitOfWork,
          images,
          workingCopies: copies,
          objectStore: store,
          clock: new FixedClock(at),
        });
      sweepNow = sweepWith(T0);
      sweepLater = sweepWith(T0.add({ hours: 24 * 30 }));
    });
    beforeEach(() => {
      throttled = false;
    });
    afterAll(async () => {
      await app.end();
      await persistence.close();
    });

    const inUnit = <T>(work: () => Promise<T>): Promise<T> =>
      persistence.unitOfWork
        .run(market, async () => ({ ok: true as const, value: await work() }))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });

    const sellerContext = (sellerId: Id<'Seller'> = SELLER) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId,
        }),
      );

    async function draftedProduct(imageIds: string[] = []): Promise<Product> {
      const created = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'SELLER',
        sellerId: SELLER,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        variantId: uuid7() as Id<'Variant'>,
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      await inUnit(() => products.add(market, created.value));
      await saveDraft(created.value.state.id, imageIds);
      return created.value;
    }

    const saveDraft = (productId: Id<'Product'>, imageIds: string[]) =>
      inUnit(() =>
        copies.save(market, {
          productId,
          content: {
            texts: { en: { name: 'Dates', description: 'Sweet and soft' } },
            categoryIds: [categoryId],
            taxCategoryCode: 't1',
            imageIds,
          },
          contentSchemaVersion: 1,
          baseRevisionId: null,
          lastSavedAt: T0,
          lastSavedByAccountId: uuid7() as Id<'Account'>,
        }),
      );

    async function uploaded(productId: Id<'Product'>, data?: string) {
      const result = await upload.execute(sellerContext(), {
        productId,
        data: data ?? (await photo()),
      });
      if (!result.ok) throw new Error(result.error.code);
      return result.value;
    }

    it('stores three metadata-free JPEG renditions and lists the photo', async () => {
      const product = await draftedProduct();
      const exif = await sharp({
        create: { width: 900, height: 600, channels: 3, background: '#336699' },
      })
        .withExif({ IFD0: { Copyright: 'secret-owner' } })
        .jpeg()
        .toBuffer();
      const view = await uploaded(product.state.id, exif.toString('base64'));
      expect(view).toMatchObject({ width: 900, height: 600 });

      const keys = [...store.objects.keys()].filter((key) => key.includes(view.imageId));
      expect(keys.sort()).toEqual(
        ['large', 'medium', 'thumb']
          .map((size) => `${product.state.id}/${view.imageId}/${size}`)
          .sort(),
      );
      for (const key of keys) {
        const meta = await sharp(store.objects.get(key)).metadata();
        expect(meta.format).toBe('jpeg');
        expect(meta.exif).toBeUndefined();
      }
      const thumb = await sharp(
        store.objects.get(`${product.state.id}/${view.imageId}/thumb`),
      ).metadata();
      expect(Math.max(thumb.width ?? 0, thumb.height ?? 0)).toBeLessThanOrEqual(240);

      const listed = await list.execute(sellerContext(), { productId: product.state.id });
      expect(listed.ok && listed.value.map((image) => image.imageId)).toEqual([view.imageId]);
    });

    it('serves a rendition to the owner only, as image/jpeg', async () => {
      const product = await draftedProduct();
      const view = await uploaded(product.state.id);
      const mine = await read.execute(sellerContext(), {
        productId: product.state.id,
        imageId: view.imageId,
        size: 'medium',
      });
      expect(mine.ok && mine.value.contentType).toBe('image/jpeg');
      for (const [sellerId, imageId, size] of [
        [OTHER, view.imageId, 'medium'],
        [SELLER, uuid7(), 'medium'],
        [SELLER, view.imageId, 'huge'],
      ] as const) {
        const result = await read.execute(sellerContext(sellerId), {
          productId: product.state.id,
          imageId,
          size,
        });
        expect(result.ok).toBe(false);
      }
      const foreign = await read.execute(sellerContext(OTHER), {
        productId: product.state.id,
        imageId: view.imageId,
        size: 'medium',
      });
      expect(!foreign.ok && foreign.error.code).toBe('image.not-found');
    });

    it('answers another seller as product.not-found and stores nothing', async () => {
      const product = await draftedProduct();
      const before = store.objects.size;
      const result = await upload.execute(sellerContext(OTHER), {
        productId: product.state.id,
        data: await photo(),
      });
      expect(!result.ok && result.error.code).toBe('product.not-found');
      expect(store.objects.size).toBe(before);
    });

    it.each([
      [
        'not an image',
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500"/></svg>',
        ).toString('base64'),
        'file.unsupported-type',
      ],
      [
        'garbage bytes',
        Buffer.from('zzzzzzzzzzzzzzzzzzzzzzzz').toString('base64'),
        'file.unsupported-type',
      ],
      ['a tiny photo', null, 'file.too-small'],
    ])('refuses %s', async (_label, data, expected) => {
      const product = await draftedProduct();
      const before = store.objects.size;
      const result = await upload.execute(sellerContext(), {
        productId: product.state.id,
        data: data ?? (await photo(50, 50)),
      });
      expect(!result.ok && result.error.code).toBe(expected);
      expect(store.objects.size).toBe(before);
    });

    it('refuses a GIF by its content, whatever it is called', async () => {
      const product = await draftedProduct();
      const result = await upload.execute(sellerContext(), {
        productId: product.state.id,
        data: await photo(400, 400, 'gif'),
      });
      expect(!result.ok && result.error.code).toBe('file.unsupported-type');
    });

    it('accepts PNG and WebP and flattens transparency onto white', async () => {
      const product = await draftedProduct();
      for (const format of ['png', 'webp'] as const) {
        const view = await uploaded(product.state.id, await photo(400, 400, format));
        const pixel = await sharp(store.objects.get(`${product.state.id}/${view.imageId}/large`))
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(pixel.info.channels).toBeLessThanOrEqual(3);
      }
    });

    it('refuses malformed base64, an oversized body and a throttled account', async () => {
      const product = await draftedProduct();
      const bad = await upload.execute(sellerContext(), {
        productId: product.state.id,
        data: 'not base64!!',
      });
      expect(!bad.ok && bad.error.code).toBe('validation.failed');
      const big = await upload.execute(sellerContext(), {
        productId: product.state.id,
        data: 'A'.repeat(6_000_000),
      });
      expect(!big.ok && big.error.code).toBe('file.too-large');
      throttled = true;
      const slow = await upload.execute(sellerContext(), {
        productId: product.state.id,
        data: await photo(),
      });
      expect(!slow.ok && slow.error.code).toBe('request.throttled');
    });

    it('stops at the library limit', async () => {
      const product = await draftedProduct();
      const data = await photo();
      for (let index = 0; index < MAX_IMAGES_PER_PRODUCT; index += 1) {
        await uploaded(product.state.id, data);
      }
      const result = await upload.execute(sellerContext(), { productId: product.state.id, data });
      expect(!result.ok && result.error.code).toBe('image.limit-reached');
    });

    it('deletes an unused photo and its files', async () => {
      const product = await draftedProduct();
      const view = await uploaded(product.state.id);
      const removed = await remove.execute(sellerContext(), {
        productId: product.state.id,
        imageId: view.imageId,
      });
      expect(removed.ok).toBe(true);
      expect([...store.objects.keys()].some((key) => key.includes(view.imageId))).toBe(false);
      const again = await remove.execute(sellerContext(), {
        productId: product.state.id,
        imageId: view.imageId,
      });
      expect(!again.ok && again.error.code).toBe('image.not-found');
    });

    it('stores the photos of a submitted revision in order and keeps them from deletion', async () => {
      const product = await draftedProduct();
      const first = await uploaded(product.state.id);
      const second = await uploaded(product.state.id);
      await saveDraft(product.state.id, [second.imageId, first.imageId]);

      const submitted = await submit.execute(sellerContext(), {
        productId: product.state.id,
        replacePending: false,
      });
      if (!submitted.ok) throw new Error(submitted.error.code);
      const revision = await inUnit(() =>
        revisions.find(market, product.state.id, submitted.value.revisionId),
      );
      expect(revision?.content.imageIds).toEqual([second.imageId, first.imageId]);
      // A photo on any revision goes to review, even with approval off (H1).
      expect(revision?.sensitiveReasons).toContain('image-added-or-replaced');

      const refused = await remove.execute(sellerContext(), {
        productId: product.state.id,
        imageId: first.imageId,
      });
      expect(!refused.ok && refused.error.code).toBe('image.in-use');
      expect([...store.objects.keys()].some((key) => key.includes(first.imageId))).toBe(true);
    });

    it('refuses a draft that lists a photo of another product or an unknown one', async () => {
      const mine = await draftedProduct();
      const other = await draftedProduct();
      const foreign = await uploaded(other.state.id);
      await saveDraft(mine.state.id, [foreign.imageId, uuid7()]);
      const result = await submit.execute(sellerContext(), {
        productId: mine.state.id,
        replacePending: false,
      });
      expect(!result.ok && result.error.code).toBe('revision.not-ready');
      if (!result.ok && result.error.code === 'revision.not-ready') {
        expect(result.error.issues).toEqual([
          { path: 'imageIds.0', code: 'unavailable' },
          { path: 'imageIds.1', code: 'unavailable' },
        ]);
      }
    });

    it('the database refuses a revision photo of another product', async () => {
      const mine = await draftedProduct();
      const other = await draftedProduct();
      const foreign = await uploaded(other.state.id);
      const revisionId = uuid7();
      await expect(
        app.query(
          `INSERT INTO catalog.product_revision_images (market_id, tenant_id, revision_id, product_id, image_id, position)
         VALUES ($1, $2, $3, $4, $5, 1)`,
          [market.marketId, market.tenantId, revisionId, mine.state.id, foreign.imageId],
        ),
      ).rejects.toThrow();
    });

    const adminContext = () =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: null,
        }),
      );
    const systemContext = () => testCallContext(market, 'system', 'sweep-db-0001');
    const stateOf = async (imageId: string) =>
      (
        await app.query(
          'SELECT state, taken_down_at, takedown_reason_code FROM catalog.product_images WHERE id = $1',
          [imageId],
        )
      ).rows[0] as
        | { state: string; taken_down_at: Date | null; takedown_reason_code: string | null }
        | undefined;
    const objectsOf = (imageId: string) =>
      [...store.objects.keys()].filter((key) => key.includes(imageId));

    it('lists a revision to a reviewer in order and serves a rendition to the admin only', async () => {
      const product = await draftedProduct();
      const first = await uploaded(product.state.id);
      const second = await uploaded(product.state.id);
      await saveDraft(product.state.id, [second.imageId, first.imageId]);
      const result = await submit.execute(sellerContext(), {
        productId: product.state.id,
        replacePending: false,
      });
      if (!result.ok) throw new Error(result.error.code);

      const listed = await revisionImages.execute(adminContext(), {
        productId: product.state.id,
        revisionId: result.value.revisionId,
      });
      expect(listed.ok && listed.value.map((i) => [i.imageId, i.position, i.state])).toEqual([
        [second.imageId, 1, 'clean'],
        [first.imageId, 2, 'clean'],
      ]);
      const unknown = await revisionImages.execute(adminContext(), {
        productId: product.state.id,
        revisionId: uuid7(),
      });
      expect(!unknown.ok && unknown.error.code).toBe('revision.not-found');

      const served = await adminRead.execute(adminContext(), {
        productId: product.state.id,
        imageId: first.imageId,
        size: 'thumb',
      });
      expect(served.ok && served.value.contentType).toBe('image/jpeg');
      const asSeller = await adminRead.execute(sellerContext(), {
        productId: product.state.id,
        imageId: first.imageId,
        size: 'thumb',
      });
      expect(!asSeller.ok && asSeller.error.code).toBe('access.denied');
      const wrongProduct = await adminRead.execute(adminContext(), {
        productId: (await draftedProduct()).state.id,
        imageId: first.imageId,
        size: 'thumb',
      });
      expect(!wrongProduct.ok && wrongProduct.error.code).toBe('image.not-found');
    });

    it('takes a photo down once: row marked, files gone, one event, no longer served or listed to the seller', async () => {
      const product = await draftedProduct();
      const view = await uploaded(product.state.id);
      events.length = 0;
      const done = await takeDown.execute(adminContext(), {
        productId: product.state.id,
        imageId: view.imageId,
        reasonCode: 'certification-mark',
      });
      expect(done.ok).toBe(true);
      expect(await stateOf(view.imageId)).toMatchObject({
        state: 'taken-down',
        takedown_reason_code: 'certification-mark',
      });
      expect((await stateOf(view.imageId))?.taken_down_at).toBeInstanceOf(Date);
      expect(objectsOf(view.imageId)).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(['catalog.image-taken-down.v1']);

      const again = await takeDown.execute(adminContext(), {
        productId: product.state.id,
        imageId: view.imageId,
        reasonCode: 'other',
      });
      expect(again.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect((await stateOf(view.imageId))?.takedown_reason_code).toBe('certification-mark');

      const served = await adminRead.execute(adminContext(), {
        productId: product.state.id,
        imageId: view.imageId,
        size: 'thumb',
      });
      expect(!served.ok && served.error.code).toBe('image.not-found');
      const listed = await list.execute(sellerContext(), { productId: product.state.id });
      expect(listed.ok && listed.value).toEqual([]);
      const readBySeller = await read.execute(sellerContext(), {
        productId: product.state.id,
        imageId: view.imageId,
        size: 'thumb',
      });
      expect(!readBySeller.ok && readBySeller.error.code).toBe('image.not-found');

      // The takedown record stays: the seller cannot delete a taken-down photo (Hassan #384 L1).
      const deleted = await remove.execute(sellerContext(), {
        productId: product.state.id,
        imageId: view.imageId,
      });
      expect(!deleted.ok && deleted.error.code).toBe('image.not-found');
      expect((await stateOf(view.imageId))?.state).toBe('taken-down');
    });

    it('refuses a bad reason, a seller and an unknown photo; stores nothing', async () => {
      const product = await draftedProduct();
      const view = await uploaded(product.state.id);
      events.length = 0;
      const bad = await takeDown.execute(adminContext(), {
        productId: product.state.id,
        imageId: view.imageId,
        reasonCode: 'because',
      });
      expect(!bad.ok && bad.error.code).toBe('validation.failed');
      const seller = await takeDown.execute(sellerContext(), {
        productId: product.state.id,
        imageId: view.imageId,
        reasonCode: 'other',
      });
      expect(!seller.ok && seller.error.code).toBe('access.denied');
      const unknown = await takeDown.execute(adminContext(), {
        productId: product.state.id,
        imageId: uuid7(),
        reasonCode: 'other',
      });
      expect(!unknown.ok && unknown.error.code).toBe('image.not-found');
      expect((await stateOf(view.imageId))?.state).toBe('clean');
      expect(events).toEqual([]);
    });

    it('a taken-down photo cannot join a new revision, and the draft is refused at submit', async () => {
      const product = await draftedProduct();
      const view = await uploaded(product.state.id);
      await takeDown.execute(adminContext(), {
        productId: product.state.id,
        imageId: view.imageId,
        reasonCode: 'rights',
      });
      await expect(
        app.query(
          `INSERT INTO catalog.product_revision_images (market_id, tenant_id, revision_id, product_id, image_id, position)
           VALUES ($1, $2, $3, $4, $5, 1)`,
          [market.marketId, market.tenantId, uuid7(), product.state.id, view.imageId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await saveDraft(product.state.id, [view.imageId]);
      const result = await submit.execute(sellerContext(), {
        productId: product.state.id,
        replacePending: false,
      });
      expect(!result.ok && result.error.code).toBe('revision.not-ready');
    });

    it('keeps the revision row of a photo taken down later and lists it as taken down', async () => {
      const product = await draftedProduct();
      const photo = await uploaded(product.state.id);
      await saveDraft(product.state.id, [photo.imageId]);
      const result = await submit.execute(sellerContext(), {
        productId: product.state.id,
        replacePending: false,
      });
      if (!result.ok) throw new Error(result.error.code);
      const done = await takeDown.execute(adminContext(), {
        productId: product.state.id,
        imageId: photo.imageId,
        reasonCode: 'certification-mark',
      });
      expect(done.ok).toBe(true);
      const listed = await revisionImages.execute(adminContext(), {
        productId: product.state.id,
        revisionId: result.value.revisionId,
      });
      expect(listed.ok && listed.value.map((i) => [i.imageId, i.state])).toEqual([
        [photo.imageId, 'taken-down'],
      ]);
    });

    describe('the state guard and the grants', () => {
      it('allows clean to taken-down only, never back, never a second move', async () => {
        const product = await draftedProduct();
        const view = await uploaded(product.state.id);
        const set = (state: string, extra = 'now()', who = 'null', reason = "'other'") =>
          app.query(
            `UPDATE catalog.product_images SET state = $2, taken_down_at = ${extra},
               taken_down_by_account_id = ${who === 'null' ? 'NULL' : '$3'},
               takedown_reason_code = ${reason} WHERE id = $1`,
            who === 'null' ? [view.imageId, state] : [view.imageId, state, who],
          );
        // The three takedown columns go together with the state (CHECK).
        await expect(set('taken-down')).rejects.toMatchObject({ code: '23514' });
        await set('taken-down', 'now()', uuid7());
        await expect(set('clean', 'NULL', 'null', 'NULL')).rejects.toMatchObject({
          code: '23514',
        });
        await expect(set('taken-down', 'now()', uuid7())).rejects.toMatchObject({
          code: '23514',
        });
        expect((await stateOf(view.imageId))?.state).toBe('taken-down');
      });

      it('refuses a reason outside the closed list and an update of any other column', async () => {
        const product = await draftedProduct();
        const view = await uploaded(product.state.id);
        await expect(
          app.query(
            `UPDATE catalog.product_images SET state = 'taken-down', taken_down_at = now(),
               taken_down_by_account_id = $2, takedown_reason_code = 'whim' WHERE id = $1`,
            [view.imageId, uuid7()],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          app.query('UPDATE catalog.product_images SET pixel_width = 10 WHERE id = $1', [
            view.imageId,
          ]),
        ).rejects.toMatchObject({ code: '42501' });
      });

      it('refuses to delete a photo a revision holds with a foreign key violation (23503)', async () => {
        const photo = await uploaded((await draftedProduct()).state.id);
        await submittedWith(photo.imageId);
        await expect(
          app.query('DELETE FROM catalog.product_images WHERE id = $1', [photo.imageId]),
        ).rejects.toMatchObject({ code: '23503' });
      });

      async function submittedWith(imageId: string) {
        // The photo belongs to another product than the one drafted here, so build its own.
        const row = await app.query('SELECT product_id FROM catalog.product_images WHERE id = $1', [
          imageId,
        ]);
        const productId = (row.rows[0] as { product_id: string }).product_id as Id<'Product'>;
        await saveDraft(productId, [imageId]);
        const result = await submit.execute(sellerContext(), {
          productId,
          replacePending: false,
        });
        if (!result.ok) throw new Error(result.error.code);
        return { product: productId };
      }
    });

    describe('the orphan sweep', () => {
      it('keeps young photos, photos a revision holds and photos a draft names; removes the rest', async () => {
        const product = await draftedProduct();
        const orphan = await uploaded(product.state.id);
        const held = await uploaded(product.state.id);
        await saveDraft(product.state.id, [held.imageId]);
        const submittedResult = await submit.execute(sellerContext(), {
          productId: product.state.id,
          replacePending: false,
        });
        if (!submittedResult.ok) throw new Error(submittedResult.error.code);
        // `held` is on a revision; `loneNamed` is only named by a draft.
        const solo = await draftedProduct();
        const loneOrphan = await uploaded(solo.state.id);
        const loneNamed = await uploaded(solo.state.id);
        await saveDraft(solo.state.id, [loneNamed.imageId]);

        // At the upload instant nothing is old enough.
        const young = await sweepNow.execute(systemContext(), {});
        expect(young.ok && young.value.deleted).toBe(0);
        expect(await stateOf(orphan.imageId)).toBeDefined();

        const swept = await sweepLater.execute(systemContext(), {});
        expect(swept.ok).toBe(true);
        expect(await stateOf(orphan.imageId)).toBeUndefined();
        expect(objectsOf(orphan.imageId)).toEqual([]);
        expect(await stateOf(loneOrphan.imageId)).toBeUndefined();
        expect(objectsOf(loneOrphan.imageId)).toEqual([]);
        for (const kept of [held, loneNamed]) {
          expect((await stateOf(kept.imageId))?.state).toBe('clean');
          expect(objectsOf(kept.imageId)).toHaveLength(3);
        }
        const again = await sweepLater.execute(systemContext(), {});
        expect(again.ok && again.value.deleted).toBe(0);
        const asAdmin = await sweepLater.execute(adminContext(), {});
        expect(!asAdmin.ok && asAdmin.error.code).toBe('access.denied');
      });

      it('leaves taken-down photos alone', async () => {
        const product = await draftedProduct();
        const view = await uploaded(product.state.id);
        await takeDown.execute(adminContext(), {
          productId: product.state.id,
          imageId: view.imageId,
          reasonCode: 'other',
        });
        await sweepLater.execute(systemContext(), {});
        expect((await stateOf(view.imageId))?.state).toBe('taken-down');
      });
    });
  },
);
