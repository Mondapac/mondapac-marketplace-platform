import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRead } from '../src/storefront/api.ts';
import {
  PAGE_READ_MAX_BODY_BYTES,
  PAGE_READ_MAX_ENTRIES,
  PAGE_READ_TTL_MS,
  cachedPageRead,
  clearPageReadCache,
  keepPageRead,
  keepProductAnswer,
  keepStoreAnswer,
  pageReadCacheSize,
} from '../src/storefront/page-read-cache.ts';

// SEO package 5, follow-up 2 (Hassan's M-1): the proxy's "does this page exist" read and the
// page's own read share a short cache keyed by Market and path, so a page that exists costs one
// API read and a router prefetch costs none. Only definite answers are kept, never a failure.

const ID = '3f2b8c1e-9a4d-4e6b-8f10-2d7c5a9b0e11';
const PRODUCT_PATH = `search/product-detail/${ID}`;
const world = vi.hoisted(() => ({ host: 'shop.example' }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: world.host })),
}));
vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve('en'),
  getTranslations: () =>
    Promise.resolve(Object.assign((code: string) => code, { has: () => false })),
}));
vi.mock('../src/storefront/config.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  storefrontApiConfig: () => ({
    apiBaseUrl: 'https://api.shop.example',
    hosts: [
      { origin: 'https://shop.example', host: 'shop.example', marketId: 'AU' },
      { origin: 'https://www.shop.example', host: 'www.shop.example', marketId: 'AU' },
      { origin: 'https://nz.shop.example', host: 'nz.shop.example', marketId: 'NZ' },
    ],
    clientAddressKey: null,
    imageOrigin: null,
  }),
}));

const { proxy } = await import('../proxy.ts');
const { loadProduct, loadSeller } = await import('../src/storefront/source.ts');

const productBody = {
  productId: ID,
  name: 'Halal lamb shoulder',
  shortDescription: null,
  description: null,
  categoryIds: [],
  offers: [
    {
      offerId: '01990000-0000-7000-8000-000000001001',
      sellerId: '01990000-0000-7000-8000-000000005001',
      seller: { storeName: 'Kedron Butchers', minimumOrder: null },
      units: [
        {
          variantId: '01990000-0000-7000-8000-000000002001',
          label: null,
          price: { amount: '1890', currency: 'AUD' },
          taxInclusive: true,
          special: null,
          stock: { status: 'in-stock', onlyLeft: null },
        },
      ],
    },
  ],
};
const storeBody = {
  slug: 'kedron',
  name: 'Kedron',
  serviceAreaCode: 'greater-brisbane',
  sellingSince: 2026,
  minimumOrder: null,
};

/** The API: each route's answer, and every request it got (path and Market). */
const api = {
  answers: new Map<string, () => Response>(),
  calls: [] as { path: string; market: string | null; timeout: boolean }[],
};

beforeEach(() => {
  clearPageReadCache();
  world.host = 'shop.example';
  api.answers.clear();
  api.calls = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const path = new URL(url).pathname.slice(1) + new URL(url).search;
      api.calls.push({
        path,
        market: new Headers(init.headers).get('x-market-id'),
        timeout: init.signal instanceof AbortSignal,
      });
      const answer = api.answers.get(path);
      return Promise.resolve(answer ? answer() : Response.json({ items: [] }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://${world.host}${path}`, { headers: { host: world.host, ...headers } });
const readsOf = (path: string) => api.calls.filter((call) => call.path === path);

describe('one API read per page view', () => {
  it('reads an existing product once for the proxy check and the page together', async () => {
    api.answers.set(PRODUCT_PATH, () => Response.json(productBody));

    const response = await proxy(request(`/p/halal-lamb-shoulder-${ID}`));
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    const product = await loadProduct(ID);

    expect(product?.name).toBe('Halal lamb shoulder');
    expect(readsOf(PRODUCT_PATH)).toEqual([{ path: PRODUCT_PATH, market: 'AU', timeout: true }]);
  });

  it('reads an existing store once for the proxy check and the page together', async () => {
    api.answers.set('sellers/stores/kedron', () => Response.json(storeBody));

    await proxy(request('/s/kedron'));
    const shop = await loadSeller('kedron');

    expect(shop?.name).toBe('Kedron');
    expect(readsOf('sellers/stores/kedron')).toHaveLength(1);
  });

  it('makes no read for a router prefetch, of either kind', async () => {
    await proxy(request(`/p/halal-lamb-shoulder-${ID}`, { 'next-router-prefetch': '1' }));
    await proxy(request('/s/kedron', { 'next-router-prefetch': '1', rsc: '1' }));
    await proxy(request('/s/kedron', { 'next-router-segment-prefetch': '/_tree' }));

    expect(api.calls).toEqual([]);
  });

  it('gives the proxy read a short time-out and the page the full one', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    api.answers.set('sellers/stores/kedron', () =>
      Response.json({ code: 'sellers.store-not-found' }, { status: 404 }),
    );

    await proxy(request('/s/other'));
    expect(timeout).toHaveBeenLastCalledWith(1000);
    clearPageReadCache();
    await loadSeller('kedron');
    expect(timeout).toHaveBeenLastCalledWith(3000);
  });
});

describe('the cache keying', () => {
  it('never answers one Market from another, and shares within a Market', async () => {
    api.answers.set(PRODUCT_PATH, () => Response.json(productBody));

    await proxy(request(`/p/x-${ID}`));
    world.host = 'nz.shop.example';
    await proxy(request(`/p/x-${ID}`));
    world.host = 'www.shop.example';
    await proxy(request(`/p/x-${ID}`));

    expect(readsOf(PRODUCT_PATH).map((call) => call.market)).toEqual(['AU', 'NZ']);
  });

  it('never caches for a host that is not listed', async () => {
    world.host = 'evil.example';
    await proxy(request(`/p/x-${ID}`));
    await proxy(request(`/p/x-${ID}`));

    expect(api.calls).toEqual([]);
    expect(pageReadCacheSize()).toBe(0);
  });
});

describe('what the cache keeps', () => {
  const NOW = 1_000_000;
  const found: ApiRead<unknown> = { kind: 'ok', body: { name: 'a' } };
  const gone: ApiRead<unknown> = { kind: 'failed', status: 404 };

  it('keeps a "missing" answer only until it expires', () => {
    keepPageRead('AU', PRODUCT_PATH, gone, keepProductAnswer, NOW);

    expect(cachedPageRead('AU', PRODUCT_PATH, NOW + PAGE_READ_TTL_MS - 1)).toEqual(gone);
    expect(cachedPageRead('AU', PRODUCT_PATH, NOW + PAGE_READ_TTL_MS)).toBeUndefined();
    expect(pageReadCacheSize()).toBe(0);
  });

  it('never keeps a failure, a time-out, a bare 404 of a store or the sample', () => {
    keepPageRead('AU', 'a', { kind: 'failed', status: 503 }, keepProductAnswer, NOW);
    keepPageRead('AU', 'b', { kind: 'failed' }, keepProductAnswer, NOW);
    keepPageRead('AU', 'c', gone, keepStoreAnswer, NOW);
    keepPageRead('AU', 'd', { kind: 'failed', status: 404, code: 'x' }, keepStoreAnswer, NOW);
    keepPageRead('AU', 'e', { kind: 'off' }, keepProductAnswer, NOW);

    expect(pageReadCacheSize()).toBe(0);
  });

  it('does not cache a failed read through the proxy: the page reads again', async () => {
    api.answers.set(PRODUCT_PATH, () => Response.json({}, { status: 503 }));
    await proxy(request(`/p/x-${ID}`));
    api.answers.set(PRODUCT_PATH, () => Response.json(productBody));
    await loadProduct(ID);

    expect(readsOf(PRODUCT_PATH)).toHaveLength(2);
  });

  it('holds at most its cap, dropping the oldest first', () => {
    for (let i = 0; i < PAGE_READ_MAX_ENTRIES + 25; i += 1) {
      keepPageRead('AU', `p/${String(i)}`, found, keepProductAnswer, NOW);
    }

    expect(pageReadCacheSize()).toBe(PAGE_READ_MAX_ENTRIES);
    expect(cachedPageRead('AU', 'p/0', NOW)).toBeUndefined();
    expect(cachedPageRead('AU', `p/${String(PAGE_READ_MAX_ENTRIES + 24)}`, NOW)).toEqual(found);
  });

  it('hands out a copy, so a caller cannot change what the next one reads', () => {
    keepPageRead('AU', 'p', { kind: 'ok', body: { name: 'a' } }, keepProductAnswer, NOW);
    const first = cachedPageRead<{ name: string }>('AU', 'p', NOW);
    if (first?.kind === 'ok') first.body.name = 'changed';

    expect(cachedPageRead('AU', 'p', NOW)).toEqual(found);
  });

  it('does not keep a body larger than its byte limit', () => {
    const big = { kind: 'ok' as const, body: { text: 'x'.repeat(PAGE_READ_MAX_BODY_BYTES) } };
    keepPageRead('AU', 'big', big, keepProductAnswer, NOW);

    expect(pageReadCacheSize()).toBe(0);
  });
});
