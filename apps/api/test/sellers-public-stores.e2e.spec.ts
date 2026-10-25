import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok } from '@mondapac/shared-kernel';
import request from 'supertest';
import { PublishedStoreList } from '../src/modules/sellers/application/use-cases/published-store-list.use-case';
import { PublishedStoreRead } from '../src/modules/sellers/application/use-cases/published-store-read.use-case';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The public store reads over HTTP (slice 12): GET /sellers/stores and GET /sellers/stores/:slug
// with the real guards, rate limiter and controller; the use cases are stubs. This proves
// anonymous access (no session read, no cookie set), the request Market, the strict query string,
// Money as a string amount, `no-store` and the status of each refusal.

type Call = { route: string; actor: string; market: string; input: unknown };

describe.each(TEST_MARKETS)('public store reads over HTTP in market %s', (code) => {
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  let app: NestExpressApplication;
  let calls: Call[];
  const next: Record<string, unknown> = {};
  const get = (path: string, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(path)
      .set({ 'x-market-id': code, ...headers });
  const stub = (route: string) => ({
    execute: (
      context: { actor: { kind: string }; market: { marketId: string } },
      input: unknown,
    ) => {
      calls.push({ route, actor: context.actor.kind, market: context.market.marketId, input });
      return Promise.resolve(next[route]);
    },
  });
  const STORE = {
    slug: 'kedron-halal',
    name: 'Kedron Halal Meats',
    serviceAreaCode: 'greater-brisbane',
    sellingSince: 2026,
  };

  beforeEach(async () => {
    calls = [];
    next.list = ok({
      items: [{ ...STORE, minimumOrder: { amount: 3000n, currency } }],
      total: 1,
      page: 1,
      pageSize: 24,
    });
    next.read = ok({ ...STORE, minimumOrder: null });
    ({ app } = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(PublishedStoreList)
          .useValue(stub('list'))
          .overrideProvider(PublishedStoreRead)
          .useValue(stub('read')),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('lists the stores to a visitor with no session, not cacheable', async () => {
    const response = await get('/sellers/stores?sort=newest&page=2&pageSize=12', {
      cookie: `__Host-session-customer-${code}=whatever`,
    });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toEqual({
      items: [{ ...STORE, minimumOrder: { amount: '3000', currency } }],
      total: 1,
      page: 1,
      pageSize: 24,
    });
    expect(calls).toEqual([
      {
        route: 'list',
        actor: 'anonymous',
        market: code,
        input: { sort: 'newest', page: 2, pageSize: 12 },
      },
    ]);
  });

  it('reads one store by slug, with no minimum as null', async () => {
    const response = await get('/sellers/stores/kedron-halal');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ ...STORE, minimumOrder: null });
    expect(calls).toEqual([
      { route: 'read', actor: 'anonymous', market: code, input: { slug: 'kedron-halal' } },
    ]);
  });

  it('shows delivery terms as clock text on the list and the store page, and none when unset', async () => {
    const stored = { day: 'same-day', fromMinute: 540, toMinute: 1440, cutoffMinute: 480 };
    const text = { day: 'same-day', from: '09:00', to: '24:00', cutoff: '08:00' };
    next.list = ok({
      items: [
        { ...STORE, delivery: stored },
        { ...STORE, slug: 'logan-road', name: 'Logan Road' },
      ],
      total: 2,
      page: 1,
      pageSize: 24,
    });
    next.read = ok({ ...STORE, delivery: stored });

    const list = await get('/sellers/stores');
    const one = await get('/sellers/stores/kedron-halal');

    expect(list.body).toEqual({
      items: [
        { ...STORE, delivery: text },
        { ...STORE, slug: 'logan-road', name: 'Logan Road' },
      ],
      total: 2,
      page: 1,
      pageSize: 24,
    });
    expect(one.body).toEqual({ ...STORE, delivery: text });
  });

  it('refuses a market-less request before any use case', async () => {
    const responses = await Promise.all(
      ['/sellers/stores', '/sellers/stores/kedron-halal'].map((path) =>
        request(app.getHttpServer()).get(path),
      ),
    );

    for (const response of responses) expect(response.status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
  });

  it.each([
    ['/sellers/stores?q=meat', 'q'],
    ['/sellers/stores?page=two', 'page'],
    ['/sellers/stores?pageSize=-1', 'pageSize'],
    ['/sellers/stores?sort=a&sort=b', 'sort'],
    ['/sellers/stores/kedron-halal?tab=about', 'tab'],
  ])('answers 400 for %s without calling the use case', async (path, field) => {
    const response = await get(path);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'validation.failed',
      details: {
        fields: expect.arrayContaining([expect.objectContaining({ path: field })]) as unknown,
      },
    });
    expect(calls).toEqual([]);
  });

  it('maps the refusals: validation 400, not found 404, unavailable 503', async () => {
    next.list = err({ code: 'validation.failed', fields: [{ path: 'sort', code: 'one-of' }] });
    next.read = err({ code: 'sellers.store-not-found' });

    const invalid = await get('/sellers/stores?sort=price');
    const missing = await get('/sellers/stores/no-such-store');

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'sort', code: 'one-of' }] },
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ statusCode: 404, code: 'sellers.store-not-found' });

    next.list = err({ code: 'sellers.unavailable' });
    next.read = err({ code: 'sellers.unavailable' });
    const listDown = await get('/sellers/stores');
    const readDown = await get('/sellers/stores/kedron-halal');

    expect(listDown.status).toBe(503);
    expect(listDown.body).toEqual({ statusCode: 503, code: 'sellers.unavailable' });
    expect(readDown.status).toBe(503);
    expect(readDown.body).toEqual({ statusCode: 503, code: 'sellers.unavailable' });
  });
});
