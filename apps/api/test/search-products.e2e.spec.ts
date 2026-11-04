import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import request from 'supertest';
import { SearchProducts } from '../src/modules/search/application/use-cases/search-products.use-case';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// GET /search/products over HTTP: the real guards, rate limiter and controller; the use case is a
// stub, so this proves anonymous access (no session, no CSRF), the Market, the strict query
// string, the answer shape, `no-store` and the status of each refusal. The use case, the index
// and the SQL have their own specs.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CATEGORY = id<'Category'>(0xca);
const PAGE = {
  items: [
    {
      offerId: id<'Offer'>(1),
      productId: id<'Product'>(2),
      sellerId: id<'Seller'>(3),
      name: 'Halal sausages',
      shortText: null,
      categoryIds: [CATEGORY],
      primaryImage: {
        imageId: id<'ProductImage'>(0x701),
        width: 1600,
        height: 1200,
        alt: 'Halal sausages',
      },
    },
  ],
  page: 1,
  pageSize: 24,
  hasMore: false,
};

describe.each(TEST_MARKETS)('product search over HTTP in market %s', (code) => {
  let app: NestExpressApplication;
  let next: unknown;
  let calls: { actor: string; market: string; input: unknown }[];
  const get = (query: string, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(`/search/products${query}`)
      .set({ 'x-market-id': code, ...headers });

  beforeEach(async () => {
    calls = [];
    next = ok(PAGE);
    ({ app } = await createTestApp({
      override: (builder) =>
        builder.overrideProvider(SearchProducts).useValue({
          execute: (
            context: { actor: { kind: string }; market: { marketId: string } },
            input: unknown,
          ) => {
            calls.push({ actor: context.actor.kind, market: context.market.marketId, input });
            return Promise.resolve(next);
          },
        }),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('answers a visitor with no session, in the request Market, and is not cacheable', async () => {
    const response = await get(`?q=sausages&category=${CATEGORY}&page=2&pageSize=10`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toEqual(JSON.parse(JSON.stringify(PAGE)));
    expect(calls).toEqual([
      {
        actor: 'anonymous',
        market: code,
        input: { q: 'sausages', category: CATEGORY, page: 2, pageSize: 10 },
      },
    ]);
  });

  it('passes a browse by category with no text, and ignores a session cookie', async () => {
    const response = await get(`?category=${CATEGORY}`, {
      cookie: `__Host-session-customer-${code}=whatever`,
    });

    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({
      actor: 'anonymous',
      input: { category: CATEGORY },
    });
  });

  it('passes a store address, alone or with a category, and answers the photo of each item', async () => {
    const alone = await get('?store=kedron-halal&page=2');
    const combined = await get(`?store=kedron-halal&category=${CATEGORY}`);

    expect(alone.status).toBe(200);
    expect(combined.status).toBe(200);
    expect((alone.body as typeof PAGE).items[0]?.primaryImage).toEqual(PAGE.items[0]?.primaryImage);
    expect(calls.map((call) => call.input)).toEqual([
      { store: 'kedron-halal', page: 2 },
      { store: 'kedron-halal', category: CATEGORY },
    ]);
    expect(calls.every((call) => call.actor === 'anonymous')).toBe(true);
  });

  it('passes a brand address, alone or with a category', async () => {
    const alone = await get('?brand=saffron-co&page=2');
    const combined = await get(`?brand=saffron-co&category=${CATEGORY}`);

    expect(alone.status).toBe(200);
    expect(combined.status).toBe(200);
    expect(calls.map((call) => call.input)).toEqual([
      { brand: 'saffron-co', page: 2 },
      { brand: 'saffron-co', category: CATEGORY },
    ]);
    expect(calls.every((call) => call.actor === 'anonymous')).toBe(true);
  });

  it('refuses a repeated or bracketed brand before the use case', async () => {
    for (const query of ['?brand=a-b&brand=c-d', '?brand[a]=1']) {
      const response = await get(query);
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('refuses a repeated or bracketed store before the use case', async () => {
    for (const query of ['?store=a-b&store=c-d', '?store[a]=1']) {
      const response = await get(query);
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('maps a use case refusal of the store to validation.failed 400', async () => {
    next = err({ code: 'validation.failed', fields: [{ path: 'store', code: 'with-text' }] });

    const response = await get('?q=tea&store=kedron-halal');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'store', code: 'with-text' }] },
    });
  });

  it('refuses the market-less request before the use case', async () => {
    const response = await request(app.getHttpServer()).get('/search/products?q=tea');

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
  });

  it.each([
    ['an unknown parameter', '?q=tea&order=price', 'order'],
    ['a repeated q', '?q=tea&q=coffee', 'q'],
    ['a bracketed q', '?q[a]=1', 'q[a]'],
    ['a non-numeric page', '?q=tea&page=two', 'page'],
    ['a negative pageSize', '?q=tea&pageSize=-1', 'pageSize'],
    ['a decimal page', '?q=tea&page=1.5', 'page'],
  ])('answers 400 for %s without calling the use case', async (_name, query, path) => {
    const response = await get(query);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: expect.arrayContaining([expect.objectContaining({ path })]) as unknown },
    });
    expect(calls).toEqual([]);
  });

  it('maps the use case refusals: validation 400, unavailable 503', async () => {
    next = err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-short' }] });
    const invalid = await get('?q=a');
    next = err({ code: 'search.unavailable' });
    const unavailable = await get('?q=tea');

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'q', code: 'too-short' }] },
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ statusCode: 503, code: 'search.unavailable' });
  });

  it("is rate limited per origin with the Market's default limit, then 429 with our code", async () => {
    const limit = code === 'AU' ? 300 : 200;
    let last = 200;
    for (let sent = 0; sent < limit; sent += 1) last = (await get('?q=tea')).status;
    const refused = await get('?q=tea');

    expect(last).toBe(200);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ statusCode: 429, code: 'request.throttled' });
    expect(calls).toHaveLength(limit);
  }, 60_000);
});

describe.each(TEST_MARKETS)('product search with the real use case in market %s', (code) => {
  let app: NestExpressApplication;
  beforeEach(async () => {
    ({ app } = await createTestApp({}));
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses a text query together with a store as 400 validation.failed, before any read', async () => {
    const response = await request(app.getHttpServer())
      .get('/search/products?q=tea&store=kedron-halal')
      .set({ 'x-market-id': code });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'store', code: 'with-text' }] },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a brand together with a store or a text query as 400 validation.failed, before any read', async () => {
    for (const [query, path, reason] of [
      ['?q=tea&brand=saffron-co', 'brand', 'with-text'],
      ['?store=kedron-halal&brand=saffron-co', 'brand', 'with-store'],
      ['?brand=Not_A_Slug', 'brand', 'format'],
    ] as const) {
      const response = await request(app.getHttpServer())
        .get(`/search/products${query}`)
        .set({ 'x-market-id': code });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path, code: reason }] },
      });
    }
  });
});
