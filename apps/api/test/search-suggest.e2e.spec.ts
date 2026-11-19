import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import request from 'supertest';
import { SuggestSearch } from '../src/modules/search/application/use-cases/suggest-search.use-case';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// GET /search/suggest over HTTP: the real guards, rate limiter and controller; the use case is a
// stub, so this proves anonymous access, the Market, the strict query string (only `q`), the
// answer shape, `no-store` and the status of each refusal. The use case, the index and the SQL
// have their own specs.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ANSWER = {
  products: [
    {
      productId: id<'Product'>(2),
      name: 'Green tea',
      sellerName: 'Kedron Halal',
      categoryName: 'Tea',
      image: { imageId: id<'ProductImage'>(0x701), width: 800, height: 600, alt: 'Green tea' },
    },
  ],
  stores: [{ storeSlug: 'kedron-halal', name: 'Kedron Halal', productCount: 4 }],
  total: 1,
  totalIsCapped: false,
};

describe.each(TEST_MARKETS)('suggestions over HTTP in market %s', (code) => {
  let app: NestExpressApplication;
  let next: unknown;
  let calls: { actor: string; market: string; input: unknown }[];
  const get = (query: string, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(`/search/suggest${query}`)
      .set({ 'x-market-id': code, ...headers });

  beforeEach(async () => {
    calls = [];
    next = ok(ANSWER);
    ({ app } = await createTestApp({
      override: (builder) =>
        builder.overrideProvider(SuggestSearch).useValue({
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
    const response = await get('?q=tea', { cookie: `__Host-session-customer-${code}=whatever` });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toEqual(ANSWER);
    expect(calls).toEqual([{ actor: 'anonymous', market: code, input: { q: 'tea' } }]);
  });

  it('answers 200 with the use case answer for a missing q too (the rule is its)', async () => {
    const response = await get('');

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ actor: 'anonymous', market: code, input: { q: undefined } }]);
  });

  it('refuses the market-less request before the use case', async () => {
    const response = await request(app.getHttpServer()).get('/search/suggest?q=tea');

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
  });

  it.each([
    ['an unknown parameter', '?q=tea&page=2', 'page'],
    ['a products parameter', '?q=tea&category=x', 'category'],
    ['a repeated q', '?q=tea&q=coffee', 'q'],
    ['a bracketed q', '?q[a]=1', 'q[a]'],
  ])('answers 400 for %s without calling the use case', async (_name, query, path) => {
    const response = await get(query);

    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: expect.arrayContaining([expect.objectContaining({ path })]) as unknown },
    });
    expect(calls).toEqual([]);
  });

  it('maps the use case refusals: validation 400, unavailable 503', async () => {
    next = err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-long' }] });
    const invalid = await get('?q=tea');
    next = err({ code: 'search.unavailable' });
    const unavailable = await get('?q=tea');

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'q', code: 'too-long' }] },
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
  }, 60_000);
});

describe.each(TEST_MARKETS)('suggestions with the real use case in market %s', (code) => {
  let app: NestExpressApplication;
  beforeEach(async () => {
    ({ app } = await createTestApp({}));
  });
  afterEach(async () => {
    await app.close();
  });

  it('answers a short q empty with no read, and refuses a long one as 400, both no-store', async () => {
    const short = await request(app.getHttpServer())
      .get('/search/suggest?q=a')
      .set({ 'x-market-id': code });
    const long = await request(app.getHttpServer())
      .get(`/search/suggest?q=${'x'.repeat(101)}`)
      .set({ 'x-market-id': code });

    expect(short.status).toBe(200);
    expect(short.body).toEqual({ products: [], stores: [], total: 0, totalIsCapped: false });
    expect(short.headers['cache-control']).toBe('no-store');
    expect(long.status).toBe(400);
    expect(long.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'q', code: 'too-long' }] },
    });
  });
});
