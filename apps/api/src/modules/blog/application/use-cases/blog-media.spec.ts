import { createHash } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  aCategory,
  content,
  createNews,
  refusal,
  REVIEWER,
  SELLER_KEYS,
  unwrap,
  WRITER,
} from '../../../../../test/support/blog-fixtures';
import {
  blogHarness,
  COVER,
  OTHER_IMAGE,
  quietLogs,
} from '../../../../../test/support/blog-harness';
import { BLOG_MEDIA_EDIT, BLOG_POST_READ } from '../../contracts/permissions';
import { MAX_MEDIA_UPLOAD_BYTES } from '../../domain/media';
import { MEDIA_PAGE_SIZE } from '../media-flow';

// The blog media library on both Market fixtures: the upload (validated before anything is
// decoded, refused as the pipeline refuses, files and row written together and audited, files
// removed when the row cannot be written), the list (newest first, paged, one Market only), the
// rendition read (by the stored key, checked against its hash) and the rule that a post's cover
// and image blocks name pictures of the library of its own Market, on save and again at the checks.

quietLogs();

const UPLOADER = [BLOG_POST_READ.key, BLOG_MEDIA_EDIT.key];
const picture = (text = 'a picture') => Buffer.from(text).toString('base64');
const UNKNOWN = '0197b000-0000-7000-8000-0000000000ee';

describe.each([
  ['AU', 'ZZ'],
  ['ZZ', 'AU'],
] as const)('blog media library in %s', (code, otherCode) => {
  const uploader = (h: ReturnType<typeof blogHarness>) => h.admin('uploader', UPLOADER);
  const writer = (h: ReturnType<typeof blogHarness>) => h.admin('writer', WRITER);

  it('stores the renditions under keys built by the server, records the row and audits it', async () => {
    const h = blogHarness(code);
    const made = unwrap(
      await h.cases.uploadMedia.execute(uploader(h), { body: { data: picture() } }),
    );
    expect(made).toMatchObject({ width: 1600, height: 1067, createdAt: h.clock.now() });
    expect(h.imageProcessor.seen).toEqual([Buffer.from('a picture')]);
    expect([...h.objects.objects.keys()].sort()).toEqual([
      `blog-media/${made.id}/large`,
      `blog-media/${made.id}/thumb`,
    ]);
    const stored = h.mediaStore.media.get(`${h.market.marketId}:${made.id}`);
    expect(stored).toMatchObject({ width: 1600, height: 1067, uploadedBytes: 9 });
    expect(stored!.renditions.map((r) => [r.size, r.objectKey])).toEqual([
      ['large', `blog-media/${made.id}/large`],
      ['thumb', `blog-media/${made.id}/thumb`],
    ]);
    expect(h.audits.map((a) => [a.action, a.targetId, a.after])).toEqual([
      ['blog.media.upload', made.id, { width: 1600, height: 1067 }],
    ]);

    // The uploaded picture is the cover of a new post at once.
    const category = await aCategory(h);
    const post = unwrap(
      await h.cases.createPost.execute(writer(h), {
        body: {
          kind: 'news',
          content: content({ categoryId: category, extra: { coverImageId: made.id } }),
        },
      }),
    );
    expect(post.open?.content.coverImageId).toBe(made.id);
  });

  it('refuses a body that is not exactly { data } of standard base64, before anything is decoded', async () => {
    const h = blogHarness(code);
    const cases: [unknown, unknown][] = [
      [{}, { code: 'validation.failed', fields: [{ path: 'data', code: 'required' }] }],
      [{ data: '' }, { code: 'validation.failed', fields: [{ path: 'data', code: 'required' }] }],
      [{ data: 12 }, { code: 'validation.failed', fields: [{ path: 'data', code: 'type' }] }],
      [{ data: 'a$b=' }, { code: 'validation.failed', fields: [{ path: 'data', code: 'format' }] }],
      [{ data: 'abc' }, { code: 'validation.failed', fields: [{ path: 'data', code: 'format' }] }],
      [
        { data: picture(), alt: 'x' },
        { code: 'validation.failed', fields: [{ path: 'alt', code: 'unknown-field' }] },
      ],
      [
        { data: 'A'.repeat(Math.ceil((MAX_MEDIA_UPLOAD_BYTES * 4) / 3) + 8) },
        { code: 'file.too-large' },
      ],
    ];
    for (const [body, expected] of cases) {
      expect(refusal(await h.cases.uploadMedia.execute(uploader(h), { body }))).toEqual(expected);
    }
    expect(h.imageProcessor.seen).toEqual([]);
    expect(h.objects.objects.size).toBe(0);
    expect(h.audits).toEqual([]);
  });

  it('answers the refusal of the pipeline, and a busy pipeline as unavailable with a short wait', async () => {
    const h = blogHarness(code);
    for (const code of [
      'file.unsupported-type',
      'file.too-many-pixels',
      'file.too-small',
      'file.unreadable',
    ] as const) {
      h.imageProcessor.refusal = code;
      expect(
        refusal(await h.cases.uploadMedia.execute(uploader(h), { body: { data: picture() } })),
      ).toEqual({
        code,
      });
    }
    h.imageProcessor.refusal = 'file.busy';
    expect(
      refusal(await h.cases.uploadMedia.execute(uploader(h), { body: { data: picture() } })),
    ).toEqual({
      code: 'blog.unavailable',
      retryAfterSeconds: 2,
    });
    expect(h.objects.objects.size).toBe(0);
    expect(h.mediaStore.media.size).toBe(2); // the two fixture pictures only
  });

  it('removes the files it wrote when the row cannot be written', async () => {
    const h = blogHarness(code);
    h.mediaStore.down = true;
    expect(
      refusal(await h.cases.uploadMedia.execute(uploader(h), { body: { data: picture() } })),
    ).toEqual({
      code: 'blog.unavailable',
    });
    expect(h.objects.objects.size).toBe(0);
    expect(h.audits).toEqual([]);
  });

  it('removes the files already written when the object store fails half way', async () => {
    const h = blogHarness(code);
    const put = h.objects.put.bind(h.objects);
    let calls = 0;
    h.objects.put = (key, bytes) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error('store down')) : put(key, bytes);
    };
    expect(
      refusal(await h.cases.uploadMedia.execute(uploader(h), { body: { data: picture() } })),
    ).toEqual({
      code: 'blog.unavailable',
    });
    expect(h.objects.objects.size).toBe(0);
    expect(h.mediaStore.media.size).toBe(2);
  });

  it('lists the pictures of its own Market only, newest first, a page at a time', async () => {
    const h = blogHarness(code);
    const other = testMarketContext(otherCode, 'default');
    h.mediaStore.seed(other, UNKNOWN);
    const made: string[] = [];
    for (let n = 0; n < MEDIA_PAGE_SIZE; n += 1) {
      h.clock.advance(Temporal.Duration.from({ seconds: 1 }));
      made.push(
        unwrap(await h.cases.uploadMedia.execute(uploader(h), { body: { data: picture(`p${n}`) } }))
          .id,
      );
    }
    const reader = h.admin('reader', [BLOG_POST_READ.key]);
    const first = unwrap(await h.cases.listMedia.execute(reader, { query: {} }));
    expect(first).toMatchObject({ page: 1, pageSize: MEDIA_PAGE_SIZE, hasMore: true });
    expect(first.items.map((item) => item.id)).toEqual([...made].reverse());
    expect(first.items[0]).toMatchObject({ width: 1600, height: 1067 });
    const second = unwrap(await h.cases.listMedia.execute(reader, { query: { page: '2' } }));
    expect(second).toMatchObject({ page: 2, hasMore: false });
    // The two fixture pictures, older than every upload; never the other Market's.
    expect(second.items.map((item) => item.id).sort()).toEqual([COVER, OTHER_IMAGE].sort());
    expect(refusal(await h.cases.listMedia.execute(reader, { query: { page: '0' } }))).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'page', code: 'value' }],
    });
    expect(refusal(await h.cases.listMedia.execute(reader, { query: { size: 'x' } }))).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'size', code: 'unknown-field' }],
    });
  });

  it('reads a rendition by its stored key; another Market, an unknown size or a changed file answer no picture', async () => {
    const h = blogHarness(code);
    const made = unwrap(
      await h.cases.uploadMedia.execute(uploader(h), { body: { data: picture() } }),
    );
    const reader = h.admin('reader', [BLOG_POST_READ.key]);
    const tag = createHash('sha256').update('a picture').digest('hex').slice(0, 16);
    const thumb = unwrap(
      await h.cases.viewMediaFile.execute(reader, { media: made.id, size: 'thumb' }),
    );
    expect(thumb).toEqual({ bytes: Buffer.from(`thumb:${tag}`), contentType: 'image/jpeg' });

    for (const input of [
      { media: made.id, size: 'medium' },
      { media: made.id, size: '../large' },
      { media: 'not-an-id', size: 'large' },
      { media: UNKNOWN, size: 'large' },
    ]) {
      expect(refusal(await h.cases.viewMediaFile.execute(reader, input))).toEqual({
        code: 'blog.media-not-found',
      });
    }
    // The same id in the other Market is no picture there.
    const elsewhere = blogHarness(otherCode);
    expect(
      refusal(
        await elsewhere.cases.viewMediaFile.execute(
          elsewhere.admin('reader', [BLOG_POST_READ.key]),
          {
            media: made.id,
            size: 'large',
          },
        ),
      ),
    ).toEqual({ code: 'blog.media-not-found' });

    // A file changed behind the row is not served.
    h.objects.objects.set(`blog-media/${made.id}/large`, Buffer.from('tampered'));
    expect(
      refusal(await h.cases.viewMediaFile.execute(reader, { media: made.id, size: 'large' })),
    ).toEqual({
      code: 'blog.unavailable',
    });
  });

  it('refuses a cover or an image block that is not a picture of the Market, naming the path', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    // A picture of the other Market is not one of this Market.
    h.mediaStore.seed(testMarketContext(otherCode, 'default'), UNKNOWN);
    const refused = refusal(
      await h.cases.createPost.execute(writer(h), {
        body: {
          kind: 'news',
          content: content({
            categoryId: category,
            extra: {
              coverImageId: UNKNOWN,
              body: [
                { type: 'paragraph', text: 'Words.' },
                { type: 'image', imageId: OTHER_IMAGE, alt: 'Known' },
                { type: 'image', imageId: UNKNOWN, alt: 'Unknown' },
              ],
            },
          }),
        },
      }),
    );
    expect(refused).toEqual({
      code: 'validation.failed',
      fields: [
        { path: 'content.coverImageId', code: 'not-found' },
        { path: 'content.body[2].imageId', code: 'not-found' },
      ],
    });

    // The same on a draft save and on a reviewer's edit.
    const post = await createNews(h, writer(h), category);
    const bad = content({ categoryId: category, extra: { coverImageId: UNKNOWN } });
    expect(
      refusal(
        await h.cases.updateDraft.execute(writer(h), { post: post.id, body: { content: bad } }),
      ),
    ).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'content.coverImageId', code: 'not-found' }],
    });
    unwrap(await h.cases.submitPost.execute(writer(h), { post: post.id }));
    expect(
      refusal(
        await h.cases.reviewerEdit.execute(h.admin('reviewer', REVIEWER), {
          post: post.id,
          body: { content: bad },
        }),
      ),
    ).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'content.coverImageId', code: 'not-found' }],
    });
  });

  it('holds a seller post to the same rule', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const sellerId = h.ids.next<'Seller'>();
    h.links.sellerAccess.set(sellerId, true);
    const refused = refusal(
      await h.cases.sellerCreatePost.execute(h.seller(sellerId, SELLER_KEYS), {
        body: {
          kind: 'news',
          content: content({ categoryId: category, extra: { coverImageId: UNKNOWN } }),
        },
      }),
    );
    expect(refused).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'content.coverImageId', code: 'not-found' }],
    });
  });

  it('still shows a draft that names a picture no longer in the library, and the checks stop it', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const post = await createNews(h, writer(h), category);
    // As a version stored before the library existed: its cover is in no library.
    h.mediaStore.media.delete(`${h.market.marketId}:${COVER}`);

    const viewed = unwrap(await h.cases.viewPost.execute(writer(h), { post: post.id }));
    expect(viewed.open?.content.coverImageId).toBe(COVER);
    const refused = refusal(await h.cases.submitPost.execute(writer(h), { post: post.id }));
    expect(refused).toEqual({
      code: 'blog.checks-failed',
      findings: [{ severity: 'error', code: 'image-not-found', path: 'coverImageId' }],
    });
  });

  it('fails the checks closed when the library cannot be read', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const post = await createNews(h, writer(h), category);
    h.mediaStore.down = true;
    const refused = refusal(await h.cases.submitPost.execute(writer(h), { post: post.id }));
    expect(refused).toEqual({
      code: 'blog.checks-failed',
      findings: [{ severity: 'error', code: 'images-unverifiable', path: null }],
    });
  });
});
