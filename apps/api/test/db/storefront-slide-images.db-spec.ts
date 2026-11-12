import { createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaSlideImageStore } from '../../src/modules/storefront/infrastructure/prisma-slide-image.store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The slide image library tables (F9) as the application role, in both Market fixtures: an image
// and its renditions are written once, one Market never sees another's, and the table CHECKs hold
// (object keys built from id and size, closed size codes).

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('slide image library in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let sql: Client;
  let store: PrismaSlideImageStore;

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    store = new PrismaSlideImageStore(persistence.service);
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });

  const inUnit = <T>(target: typeof market, work: () => Promise<T>) =>
    persistence.unitOfWork
      .run(target, async () => ok(await work()))
      .then((r) => {
        if (!r.ok) throw new Error('refused');
        return r.value;
      });

  const newImage = (id: string, hasMobile: boolean) => ({
    id: id as Id<'SlideImage'>,
    uploaderAccountId: uuid7() as Id<'Account'>,
    hasMobile,
    width: 1920,
    height: 720,
    uploadedBytes: 5000,
    createdAt: Temporal.Instant.from('2026-11-06T00:00:00Z'),
    renditions: (hasMobile
      ? (['desktop', 'desktop-small', 'mobile', 'mobile-small'] as const)
      : (['desktop', 'desktop-small'] as const)
    ).map((size) => ({
      size,
      objectKey: `slide-images/${id}/${size}`,
      sha256: createHash('sha256').update(`${id}${size}`).digest(),
      byteSize: 1000,
      width: 960,
      height: 360,
    })),
  });

  it('stores an image with its renditions and reads it back in its own Market only', async () => {
    const id = uuid7();
    await inUnit(market, () => store.insert(market, newImage(id, true)));
    const mine = await inUnit(market, () => store.existing(market, [id, uuid7()]));
    expect([...mine.entries()]).toEqual([[id, { hasMobile: true }]]);
    const theirs = await inUnit(other, () => store.existing(other, [id]));
    expect(theirs.size).toBe(0);
    const rendition = await inUnit(market, () =>
      store.rendition(market, id as Id<'SlideImage'>, 'mobile'),
    );
    expect(rendition).toMatchObject({
      size: 'mobile',
      objectKey: `slide-images/${id}/mobile`,
      byteSize: 1000,
    });
    expect(rendition?.sha256.equals(createHash('sha256').update(`${id}mobile`).digest())).toBe(
      true,
    );
    expect(
      await inUnit(other, () => store.rendition(other, id as Id<'SlideImage'>, 'mobile')),
    ).toBeNull();
    expect(
      await inUnit(market, () => store.rendition(market, id as Id<'SlideImage'>, 'desktop-small')),
    ).not.toBeNull();
  });

  it('answers an empty map for no ids', async () => {
    expect((await inUnit(market, () => store.existing(market, []))).size).toBe(0);
  });

  it('refuses an object key that is not built from the image id and size', async () => {
    const id = uuid7();
    await inUnit(market, () => store.insert(market, newImage(id, false)));
    await expect(
      sql.query(
        `INSERT INTO storefront.slide_image_renditions
           (market_id, tenant_id, image_id, size_code, object_key, sha256, byte_size, pixel_width, pixel_height)
         VALUES ($1, $2, $3, 'mobile', 'slide-images/other/mobile', $4, 1, 1, 1)`,
        [market.marketId, market.tenantId, id, createHash('sha256').update('x').digest()],
      ),
    ).rejects.toThrow();
    await expect(
      sql.query(
        `INSERT INTO storefront.slide_image_renditions
           (market_id, tenant_id, image_id, size_code, object_key, sha256, byte_size, pixel_width, pixel_height)
         VALUES ($1, $2, $3, 'huge', $4, $5, 1, 1, 1)`,
        [
          market.marketId,
          market.tenantId,
          id,
          `slide-images/${id}/huge`,
          createHash('sha256').update('x').digest(),
        ],
      ),
    ).rejects.toThrow();
  });
});
