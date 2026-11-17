import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok } from '@mondapac/shared-kernel';
import request from 'supertest';
import { SearchProducts } from '../src/modules/search/application/use-cases/search-products.use-case';
import { SearchStores } from '../src/modules/search/application/use-cases/search-stores.use-case';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// GET /search/stores over HTTP (search 1a follow-up of the QA review of #799): the real guards,
// rate limiter and controller; the use case is a stub, so this proves anonymous access (no
// session, no CSRF), the Market, the strict query string, the answer shape, `no-store`, the status
// of each refusal and the shared `public-search` limit. The use case, the read model and the SQL
// have their own specs. Runs on both Market fixtures (AU and the synthetic ZZ).

const PAGE = {
  items: [{ slug: 'alis-butcher', name: "Ali's Butcher", productCount: 7 }],
  page: 1,
  pageSize: 24,
  hasMore: false,
};

describe.each(TEST_MARKETS)('store search over HTTP in market %s', (code) => {
  let app: NestExpressApplication;
  let next: unknown;
  let calls: { actor: string; market: string; input: unknown }[];
  let productCalls: number;
  const get = (query: string, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(`/search/stores${query}`)
      .set({ 'x-market-id': code, ...headers });

  beforeEach(async () => {
    calls = [];
    productCalls = 0;
    next = ok(PAGE);
    ({ app } = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(SearchStores)
          .useValue({
            execute: (
              context: { actor: { kind: string }; market: { marketId: string } },
              input: unknown,
            ) => {
              calls.push({ actor: context.actor.kind, market: context.market.marketId, input });
              return Promise.resolve(next);
            },
          })
          .overrideProvider(SearchProducts)
          .useValue({
            execute: () => {
              productCalls += 1;
              return Promise.resolve(ok({ items: [], page: 1, pageSize: 24, hasMore: false }));
            },
          }),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('answers a visitor with no session, in the request Market, and is not cacheable', async () => {
    const response = await get('?q=butcher&page=2&pageSize=10');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toEqual(PAGE);
    expect(calls).toEqual([
      { actor: 'anonymous', market: code, input: { q: 'butcher', page: 2, pageSize: 10 } },
    ]);
  });

  it('ignores a session cookie: the actor stays anonymous', async () => {
    const response = await get('?q=butcher', {
      cookie: `__Host-session-customer-${code}=whatever`,
    });

    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({ actor: 'anonymous', input: { q: 'butcher' } });
  });

  it('refuses the market-less request before the use case', async () => {
    const response = await request(app.getHttpServer()).get('/search/stores?q=butcher');

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
  });

  it.each([
    ['an unknown parameter', '?q=tea&sort=name', 'sort'],
    ['a product-search parameter', '?q=tea&category=x', 'category'],
    ['a repeated q', '?q=tea&q=coffee', 'q'],
    ['a bracketed q', '?q[a]=1', 'q[a]'],
    ['a non-numeric page', '?q=tea&page=two', 'page'],
    ['a negative pageSize', '?q=tea&pageSize=-1', 'pageSize'],
    ['a decimal page', '?q=tea&page=1.5', 'page'],
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
    next = err({ code: 'validation.failed', fields: [{ path: 'q', code: 'required' }] });
    const invalid = await get('');
    next = err({ code: 'search.unavailable' });
    const unavailable = await get('?q=tea');

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'q', code: 'required' }] },
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ statusCode: 503, code: 'search.unavailable' });
  });

  it("shares the Market's public-search limit with the product search, per origin, then 429", async () => {
    // Its own class (Hassan L-3): AU 120 and ZZ 90 a minute. Both search routes count in it.
    const limit = code === 'AU' ? 120 : 90;
    const half = Math.floor(limit / 2);
    let last = 200;
    for (let sent = 0; sent < half; sent += 1) {
      last = (
        await request(app.getHttpServer())
          .get('/search/products?q=tea')
          .set({ 'x-market-id': code })
      ).status;
    }
    for (let sent = half; sent < limit; sent += 1) last = (await get('?q=tea')).status;
    const refused = await get('?q=tea');

    expect(last).toBe(200);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ statusCode: 429, code: 'request.throttled' });
    expect(refused.headers['retry-after']).toMatch(/^[0-9]+$/);
    expect(productCalls).toBe(half);
    expect(calls).toHaveLength(limit - half);
  }, 60_000);
});

describe.each(TEST_MARKETS)('store search with the real use case in market %s', (code) => {
  let app: NestExpressApplication;
  beforeEach(async () => {
    ({ app } = await createTestApp({}));
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses a missing or too short text as 400 validation.failed, before any read', async () => {
    for (const query of ['', '?q=a', '?page=2']) {
      const response = await request(app.getHttpServer())
        .get(`/search/stores${query}`)
        .set({ 'x-market-id': code });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [expect.objectContaining({ path: 'q' })] },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('refuses a chain of more than 8 OR terms as 400 too-many-terms, before any read', async () => {
    const q = Array.from({ length: 9 }, (_, n) => `t${n}`).join(' or ');
    const response = await request(app.getHttpServer())
      .get(`/search/stores?q=${encodeURIComponent(q)}`)
      .set({ 'x-market-id': code });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'q', code: 'too-many-terms' }] },
    });
  });
});
