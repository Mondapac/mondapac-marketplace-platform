import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import {
  categoryImageObjectKey,
  type NewCategoryImage,
} from '../../src/modules/catalog/application/ports/category-image.store';
import { PrismaCategoryEditStore } from '../../src/modules/catalog/infrastructure/prisma-category-edit.store';
import { PrismaCategoryImageStore } from '../../src/modules/catalog/infrastructure/prisma-category-image.store';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The category image store on PostgreSQL, for both Market fixtures (categories package C3c,
// migration 20261105200000_catalog_category_images): a replace clears the pointer under the
// version guard, deletes the old row with its renditions and points at the new one; at most one
// image per category; the category may only point at its own image in its own Market; the
// object key is built from the ids; the app role may insert, read and delete, never update.

const T0 = Temporal.Instant.from('2026-11-05T10:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ADMIN = uuid7() as Id<'Account'>;

describe.each(TEST_MARKETS)('catalog category image store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let owner: Client;
  let app: Client;
  let edits: PrismaCategoryEditStore;
  let store: PrismaCategoryImageStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    app = new Client({ connectionString: testDatabaseUrl() });
    await app.connect();
    edits = new PrismaCategoryEditStore(db.service);
    store = new PrismaCategoryImageStore(db.service);
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
    await db.close();
  });

  const write = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async <T>(target: typeof market, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  async function addCategory(target: typeof market): Promise<Id<'Category'>> {
    const id = uuid7() as Id<'Category'>;
    await write(target, () =>
      edits.insert(target, {
        id,
        revisionId: uuid7() as Id<'CategoryRevision'>,
        parentId: null,
        slug: `img-${uuid7().slice(-12)}`,
        texts: [
          { locale: 'en-AU', name: `Image ${id.slice(-6)}`, shortDescription: null, keywords: [] },
        ],
        seo: { title: null, description: null, noindex: false },
        showInMenu: true,
        authorAccountId: ADMIN,
        now: T0,
      }),
    );
    return id;
  }

  const imageFor = (categoryId: Id<'Category'>): NewCategoryImage => {
    const id = uuid7() as Id<'CategoryImage'>;
    return {
      id,
      uploaderAccountId: ADMIN,
      width: 1200,
      height: 800,
      uploadedBytes: 54_321,
      createdAt: T0,
      renditions: (['thumb', 'medium', 'large'] as const).map((size, index) => {
        const bytes = Buffer.from(`${id}-${size}`);
        return {
          size,
          objectKey: categoryImageObjectKey(categoryId, id, size),
          sha256: createHash('sha256').update(bytes).digest(),
          byteSize: bytes.length,
          width: 300 * (index + 1),
          height: 200 * (index + 1),
        };
      }),
    };
  };

  const ownerOf = async (target: typeof market, id: Id<'Category'>) => {
    const found = await read(target, () => store.owner(target, id));
    if (found === null) throw new Error('category not found');
    return found;
  };

  it('sets, replaces and removes the image, one row at a time, under the version guard', async () => {
    const id = await addCategory(market);
    const start = await ownerOf(market, id);
    expect(start.imageId).toBeNull();
    expect(start.status).toBe('hidden');

    const first = imageFor(id);
    const set = await write(market, () => store.replace(market, start, first));
    expect(set).toEqual({ version: start.version + 1, removed: null });
    const current = await read(market, () => store.current(market, id));
    expect(current?.id).toBe(first.id);
    expect(current?.renditions.map((r) => r.size)).toEqual(['large', 'medium', 'thumb']);
    expect(current?.renditions.find((r) => r.size === 'medium')?.objectKey).toBe(
      `category-images/${id}/${first.id}/medium`,
    );

    const second = imageFor(id);
    const afterFirst = await ownerOf(market, id);
    expect(afterFirst.imageId).toBe(first.id);
    const replaced = await write(market, () => store.replace(market, afterFirst, second));
    expect(replaced.version).toBe(afterFirst.version + 1);
    expect(replaced.removed?.imageId).toBe(first.id);
    expect([...(replaced.removed?.objectKeys ?? [])].sort()).toEqual(
      first.renditions.map((r) => r.objectKey).sort(),
    );
    const rows = await owner.query(
      `SELECT count(*)::int AS images,
              (SELECT count(*)::int FROM catalog.category_image_renditions
                WHERE market_id = $1 AND category_id = $2) AS renditions
         FROM catalog.category_images WHERE market_id = $1 AND category_id = $2`,
      [market.marketId, id],
    );
    expect(rows.rows[0]).toEqual({ images: 1, renditions: 3 });

    // A second admin who read the old version loses.
    await expect(
      write(market, () => store.replace(market, afterFirst, imageFor(id))),
    ).rejects.toBeInstanceOf(StaleAggregateError);

    const beforeRemove = await ownerOf(market, id);
    const removed = await write(market, () => store.replace(market, beforeRemove, null));
    expect(removed.removed?.imageId).toBe(second.id);
    expect((await ownerOf(market, id)).imageId).toBeNull();
    expect(await read(market, () => store.current(market, id))).toBeNull();
    const left = await owner.query(
      `SELECT count(*)::int AS n FROM catalog.category_image_renditions WHERE market_id = $1 AND category_id = $2`,
      [market.marketId, id],
    );
    expect(left.rows[0]).toEqual({ n: 0 });
  });

  it('keeps the Market boundary: a category of another Market is not found', async () => {
    const id = await addCategory(market);
    expect(await read(other, () => store.owner(other, id))).toBeNull();
    expect(await read(other, () => store.current(other, id))).toBeNull();
  });

  it('refuses a pointer to another category image, a second image and a key not built from the ids', async () => {
    const a = await addCategory(market);
    const b = await addCategory(market);
    const image = imageFor(a);
    const start = await ownerOf(market, a);
    await write(market, () => store.replace(market, start, image));

    // b may not point at a's image (FK (market_id, image_id, id)).
    await expect(
      owner.query(
        `UPDATE catalog.platform_categories SET image_id = $3 WHERE market_id = $1 AND id = $2`,
        [market.marketId, b, image.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // The current image cannot be deleted while the category points at it.
    await expect(
      owner.query(`DELETE FROM catalog.category_images WHERE market_id = $1 AND id = $2`, [
        market.marketId,
        image.id,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    // At most one image per category.
    await expect(
      owner.query(
        `INSERT INTO catalog.category_images
           (market_id, tenant_id, id, category_id, uploader_account_id, pixel_width, pixel_height, byte_size, created_at)
         VALUES ($1, $2, $3, $4, $5, 10, 10, 10, now())`,
        [market.marketId, market.tenantId, uuid7(), a, ADMIN],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // A rendition key must be `category-images/<category>/<image>/<size>`.
    const loose = uuid7();
    await owner.query(
      `INSERT INTO catalog.category_images
         (market_id, tenant_id, id, category_id, uploader_account_id, pixel_width, pixel_height, byte_size, created_at)
       VALUES ($1, $2, $3, $4, $5, 10, 10, 10, now())`,
      [market.marketId, market.tenantId, loose, b, ADMIN],
    );
    await expect(
      owner.query(
        `INSERT INTO catalog.category_image_renditions
           (market_id, tenant_id, image_id, category_id, size_code, object_key, sha256, byte_size, pixel_width, pixel_height)
         VALUES ($1, $2, $3, $4, 'thumb', $5, $6, 10, 10, 10)`,
        [market.marketId, market.tenantId, loose, b, `${a}/${loose}/thumb`, Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await owner.query(`DELETE FROM catalog.category_images WHERE market_id = $1 AND id = $2`, [
      market.marketId,
      loose,
    ]);
  });

  it('lets the app role insert, read and delete images, never update them', async () => {
    const grants = await owner.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'mondapac_app' AND table_schema = 'catalog'
          AND table_name IN ('category_images', 'category_image_renditions')
        ORDER BY table_name, privilege_type`,
    );
    expect(grants.rows).toEqual([
      { table_name: 'category_image_renditions', privilege_type: 'INSERT' },
      { table_name: 'category_image_renditions', privilege_type: 'SELECT' },
      { table_name: 'category_images', privilege_type: 'DELETE' },
      { table_name: 'category_images', privilege_type: 'INSERT' },
      { table_name: 'category_images', privilege_type: 'SELECT' },
    ]);
    await expect(
      app.query(`UPDATE catalog.category_images SET byte_size = 1 WHERE market_id = $1`, [
        market.marketId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
