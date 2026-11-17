import { createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { MediaId } from '../../src/modules/blog/application/ports/blog-media.store';
import { PrismaBlogMediaStore } from '../../src/modules/blog/infrastructure/prisma-blog-media.store';
import { PrismaBlogRepository } from '../../src/modules/blog/infrastructure/prisma-blog.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { SystemClock } from '../../src/platform/clock/system-clock';
import { aCategory, content, refusal, unwrap, WRITER } from '../support/blog-fixtures';
import { blogHarness, quietLogs } from '../support/blog-harness';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The blog media library tables (blog media upload) in both Market fixtures: a picture and its
// renditions are written once, listed newest first, one Market never sees another's, the table
// CHECKs hold (object keys built from id and size, closed size codes), and a post's cover is
// checked against the real library through the real unit of work.

quietLogs();

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('blog media library in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let sql: Client;
  let store: PrismaBlogMediaStore;

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    store = new PrismaBlogMediaStore(persistence.service);
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

  const newMedia = (id: string, createdAt = Temporal.Instant.from('2026-11-15T00:00:00Z')) => ({
    id: id as MediaId,
    uploaderAccountId: uuid7() as Id<'Account'>,
    width: 1600,
    height: 900,
    uploadedBytes: 5000,
    createdAt,
    renditions: (['large', 'thumb'] as const).map((size) => ({
      size,
      objectKey: `blog-media/${id}/${size}`,
      sha256: createHash('sha256').update(`${id}${size}`).digest(),
      byteSize: 1000,
      width: size === 'large' ? 1600 : 400,
      height: size === 'large' ? 900 : 225,
    })),
  });

  it('stores a picture with its renditions and reads it back in its own Market only', async () => {
    const id = uuid7();
    await inUnit(market, () => store.insert(market, newMedia(id)));
    expect([...(await inUnit(market, () => store.existing(market, [id, uuid7()])))]).toEqual([id]);
    expect((await inUnit(other, () => store.existing(other, [id]))).size).toBe(0);
    const thumb = await inUnit(market, () => store.rendition(market, id as MediaId, 'thumb'));
    expect(thumb).toMatchObject({
      size: 'thumb',
      objectKey: `blog-media/${id}/thumb`,
      byteSize: 1000,
      width: 400,
      height: 225,
    });
    expect(thumb?.sha256.equals(createHash('sha256').update(`${id}thumb`).digest())).toBe(true);
    expect(await inUnit(other, () => store.rendition(other, id as MediaId, 'thumb'))).toBeNull();
    expect((await inUnit(market, () => store.existing(market, []))).size).toBe(0);
  });

  it('lists newest first, then by id, a page at a time, never another Market', async () => {
    // A time in the future of every other test's rows, so these three lead the list.
    const base = Temporal.Instant.from('2099-01-01T00:00:00Z');
    const older = uuid7();
    const twinA = uuid7();
    const twinB = uuid7();
    await inUnit(market, () => store.insert(market, newMedia(older, base)));
    await inUnit(market, () => store.insert(market, newMedia(twinA, base.add({ hours: 1 }))));
    await inUnit(market, () => store.insert(market, newMedia(twinB, base.add({ hours: 1 }))));
    await inUnit(other, () => store.insert(other, newMedia(uuid7(), base.subtract({ hours: 1 }))));
    const first = await inUnit(market, () => store.list(market, { limit: 2, offset: 0 }));
    expect(first.map((m) => m.id)).toEqual([twinA, twinB].sort().reverse());
    expect(first[0]).toMatchObject({ width: 1600, height: 900 });
    expect(first[0]!.createdAt.equals(base.add({ hours: 1 }))).toBe(true);
    const second = await inUnit(market, () => store.list(market, { limit: 1, offset: 2 }));
    expect(second.map((m) => m.id)).toEqual([older]);
  });

  it('refuses an object key that is not built from the picture id and size, and an unknown size', async () => {
    const id = uuid7();
    await inUnit(market, () => store.insert(market, newMedia(id)));
    const insert = (size: string, key: string) =>
      sql.query(
        `INSERT INTO blog.media_renditions
           (market_id, tenant_id, media_id, size_code, object_key, sha256, byte_size, pixel_width, pixel_height)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 1)`,
        [
          market.marketId,
          market.tenantId,
          id,
          size,
          key,
          createHash('sha256').update('x').digest(),
        ],
      );
    await expect(insert('large', 'blog-media/other/large')).rejects.toThrow();
    await expect(insert('medium', `blog-media/${id}/medium`)).rejects.toThrow();
    // A rendition of a picture of another Market has no parent row.
    await expect(
      sql.query(
        `INSERT INTO blog.media_renditions
           (market_id, tenant_id, media_id, size_code, object_key, sha256, byte_size, pixel_width, pixel_height)
         VALUES ($1, $2, $3, 'large', $4, $5, 1, 1, 1)`,
        [
          other.marketId,
          other.tenantId,
          id,
          `blog-media/${id}/large`,
          createHash('sha256').update('x').digest(),
        ],
      ),
    ).rejects.toThrow();
  });

  it('accepts a cover of the library and refuses one that is not, through the real unit of work', async () => {
    const h = blogHarness(code, {
      posts: new PrismaBlogRepository(persistence.service),
      unitOfWork: persistence.unitOfWork,
      ids: new UuidV7IdGenerator(new SystemClock()),
      media: store,
    });
    const category = await aCategory(h, `c-${uuid7().slice(-12)}`);
    const writer = h.admin('writer', WRITER);
    const cover = uuid7();
    await inUnit(market, () => store.insert(market, newMedia(cover)));
    const post = unwrap(
      await h.cases.createPost.execute(writer, {
        body: {
          kind: 'news',
          content: content({
            categoryId: category,
            title: `Cover ${cover.slice(-8)}`,
            extra: { coverImageId: cover },
          }),
        },
      }),
    );
    expect(post.open?.content.coverImageId).toBe(cover);

    const elsewhere = uuid7();
    await inUnit(other, () => store.insert(other, newMedia(elsewhere)));
    expect(
      refusal(
        await h.cases.createPost.execute(writer, {
          body: {
            kind: 'news',
            content: content({ categoryId: category, extra: { coverImageId: elsewhere } }),
          },
        }),
      ),
    ).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'content.coverImageId', code: 'not-found' }],
    });
  });
});
