import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import request from 'supertest';
import sharp from 'sharp';
import type { PublishedImagesReader } from '../src/modules/catalog/application/ports/published-images.reader';
import { PUBLISHED_IMAGES_READER } from '../src/modules/catalog/application/ports/published-images.reader';
import { MemoryObjectStore } from '../src/platform/storage/disk-object-store';
import { OBJECT_STORE } from '../src/platform/storage/object-store';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// GET /catalog/products/:productId/images/:imageId/:size over HTTP: the real guards, rate limiter,
// controller, gate and use case, with the reader and the object store in memory. The in-memory
// reader applies the same public rule as the database one (a published product, a photo of its
// current published revision, not taken down, the request's Market only), which test/db proves
// against PostgreSQL. Proved here: the Market, anonymous access with no cookie in or out, the
// headers, the cache rule, and one identical 404 for every case that is not a public photo.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const PRODUCT = id<'Product'>(0xc001);
const DRAFT_ONLY = id<'ProductImage'>(0x7d);
const TAKEN_DOWN = id<'ProductImage'>(0x7e);
const PUBLIC = id<'ProductImage'>(0x7f);

interface Row {
  readonly market: string;
  readonly productId: string;
  readonly imageId: string;
  readonly productPublished: boolean;
  readonly inPublishedRevision: boolean;
  readonly state: 'clean' | 'taken-down';
}

class MemoryPublished implements PublishedImagesReader {
  rows: Row[] = [];
  imagesOf() {
    return Promise.resolve(new Map());
  }
  renditionKey(
    market: { marketId: string },
    productId: string,
    imageId: string,
    size: string,
  ): Promise<string | null> {
    const row = this.rows.find(
      (r) => r.market === market.marketId && r.productId === productId && r.imageId === imageId,
    );
    const open =
      row !== undefined && row.productPublished && row.inPublishedRevision && row.state === 'clean';
    return Promise.resolve(open ? `${productId}/${imageId}/${size}` : null);
  }
}

describe.each(TEST_MARKETS)('public product photos over HTTP in market %s', (code) => {
  const otherCode = TEST_MARKETS.find((c) => c !== code)!;
  let app: NestExpressApplication;
  let reader: MemoryPublished;
  let store: MemoryObjectStore;
  let jpeg: Buffer;
  const urlIn = (market: string, imageId: string, size = 'medium', productId: string = PRODUCT) =>
    `/catalog/public-images/${market}/${productId}/${imageId}/${size}`;
  const url = (imageId: string, size = 'medium', productId: string = PRODUCT) =>
    urlIn(code, imageId, size, productId);
  const get = (path: string, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(path)
      .set({ 'x-market-id': code, ...headers });
  const row = (overrides: Partial<Row> & { imageId: string }): Row => ({
    market: code,
    productId: PRODUCT,
    productPublished: true,
    inPublishedRevision: true,
    state: 'clean',
    ...overrides,
  });

  beforeAll(async () => {
    jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#2a6' },
    })
      .jpeg()
      .toBuffer();
  });
  beforeEach(async () => {
    reader = new MemoryPublished();
    store = new MemoryObjectStore();
    reader.rows = [
      row({ imageId: PUBLIC }),
      row({ imageId: DRAFT_ONLY, inPublishedRevision: false }),
      row({ imageId: TAKEN_DOWN, state: 'taken-down' }),
      // The same ids in the other Market: not readable from this one.
      { ...row({ imageId: PUBLIC }), market: otherCode },
    ];
    for (const size of ['thumb', 'medium', 'large']) {
      for (const imageId of [PUBLIC, DRAFT_ONLY, TAKEN_DOWN]) {
        await store.put(`${PRODUCT}/${imageId}/${size}`, jpeg);
      }
    }
    ({ app } = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(PUBLISHED_IMAGES_READER)
          .useValue(reader)
          .overrideProvider(OBJECT_STORE)
          .useValue(store),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  it.each(['thumb', 'medium', 'large'])(
    'serves the %s rendition to a visitor with no session, as a sandboxed JPEG',
    async (size) => {
      const response = await get(url(PUBLIC, size));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'; sandbox",
      );
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.headers['cache-control']).not.toContain('immutable');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((response.body as Buffer).equals(jpeg)).toBe(true);
    },
  );

  it('sets no cookie and ignores one even when a session cookie is sent', async () => {
    const response = await get(url(PUBLIC), {
      cookie: [
        `__Host-session-customer-${code}=whatever`,
        `__Host-session-seller-${code}=whatever`,
        'cart=abc',
      ].join('; '),
    });

    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('ignores the query string', async () => {
    expect((await get(`${url(PUBLIC)}?v=2&x=1`)).status).toBe(200);
  });

  const MISSING = id<'ProductImage'>(0x99);
  const NOT_FOUND = { statusCode: 404, code: 'image.not-found' };

  it.each([
    ['an unknown photo id', () => url(MISSING)],
    ['an unknown product id', () => url(PUBLIC, 'medium', id<'Product'>(0xc999))],
    ['a draft or pending-only photo (not in the published revision)', () => url(DRAFT_ONLY)],
    ['a taken-down photo', () => url(TAKEN_DOWN)],
    ['an unknown size', () => url(PUBLIC, 'huge')],
    ['the original', () => url(PUBLIC, 'original')],
    ['a malformed product id', () => url(PUBLIC, 'medium', 'not-a-uuid')],
    ['a malformed photo id', () => url('not-a-uuid')],
    ['a path-like photo id', () => url('..%2F..%2Fetc%2Fpasswd')],
    ['an upper-case size', () => url(PUBLIC, 'MEDIUM')],
  ])(
    'answers one 404 image.not-found for %s, never cacheable, with no cookie',
    async (_n, path) => {
      const response = await get(path());

      expect(response.status).toBe(404);
      expect(response.body).toEqual(NOT_FOUND);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['content-type']).toMatch(/json/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    },
  );

  it('answers the same 404 for a product that is not published', async () => {
    reader.rows = [row({ imageId: PUBLIC, productPublished: false })];

    const response = await get(url(PUBLIC));

    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND);
  });

  it("does not serve another Market's photo: the same ids are a 404 from here", async () => {
    reader.rows = [{ ...row({ imageId: PUBLIC }), market: otherCode }];

    const response = await get(url(PUBLIC));

    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND);
    const there = await request(app.getHttpServer()).get(urlIn(otherCode, PUBLIC));
    expect(there.status).toBe(200);
  });

  it('answers 404 when the object is missing from the store, the same as any other miss', async () => {
    store.objects.delete(`${PRODUCT}/${PUBLIC}/large`);

    const response = await get(url(PUBLIC, 'large'));

    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND);
  });

  it.each(['au', 'XYZ', 'QQ'])(
    'refuses a malformed or unhosted Market in the path (%s) before any read',
    async (market) => {
      const response = await request(app.getHttpServer()).get(urlIn(market, PUBLIC));

      expect(response.status).toBe(400);
      expect(response.headers['content-type']).not.toBe('image/jpeg');
    },
  );

  it('does not read x-market-id: the path decides the Market', async () => {
    reader.rows = [row({ imageId: PUBLIC })];

    const response = await request(app.getHttpServer())
      .get(urlIn(otherCode, PUBLIC))
      .set({ 'x-market-id': code });

    expect(response.status).toBe(404);
  });

  it('answers 503 image.unavailable, not a guess, when the store fails', async () => {
    store.get = () => Promise.reject(new Error('disk'));

    const response = await get(url(PUBLIC));

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'image.unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
