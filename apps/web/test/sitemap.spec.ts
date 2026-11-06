import { resolveRobots } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRead } from '../src/storefront/api.ts';
import { productHref } from '../src/storefront/links.ts';

// The request's Host header and what the API answers per path.
const request = vi.hoisted(
  (): { host: string | null; sampleData: boolean; api: (path: string) => unknown } => ({
    host: 'shop.example',
    sampleData: false,
    api: () => ({ kind: 'failed' }),
  }),
);

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(request.host === null ? {} : { host: request.host })),
}));
vi.mock('../src/storefront/source.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get SAMPLE_DATA() {
    return request.sampleData;
  },
}));
vi.mock('../src/storefront/config.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  storefrontApiConfig: () => ({
    apiBaseUrl: 'https://api.shop.example',
    hosts: [
      { origin: 'https://shop.example', host: 'shop.example', marketId: 'AU' },
      { origin: 'https://nz.example', host: 'nz.example', marketId: 'NZ' },
    ],
    clientAddressKey: null,
    imageOrigin: null,
  }),
}));
vi.mock('../src/storefront/api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiGet: (path: string) => Promise.resolve(request.api(path) as ApiRead<unknown>),
}));

const { default: robots } = await import('../app/robots.ts');
const { clearSitemapCache, CACHE_MS } = await import('../src/seo/sitemap.ts');
const { GET: indexRoute } = await import('../app/sitemap.xml/route.ts');
const { GET: childRoute } = await import('../app/sitemaps/[name]/route.ts');

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TREE = {
  categories: [
    { id: id(1), parentId: null, slug: 'meat', name: 'Meat' },
    { id: id(2), parentId: null, slug: 'empty-top', name: 'Empty top' },
    { id: id(3), parentId: id(1), slug: 'lamb', name: 'Lamb' },
    { id: id(4), parentId: id(1), slug: 'empty-sub', name: 'Empty sub' },
  ],
};
const item = (n: number) => ({ productId: id(1000 + n), name: `Product ${n}`, offers: [] });

/** The API: the tree, plus `search/products` answering `pages` pages of `perPage` items. */
function serve(options: { pages?: number; perPage?: number; emptyCategories?: string[] } = {}) {
  const { pages = 1, perPage = 2, emptyCategories = [id(2), id(4)] } = options;
  const reads: string[] = [];
  request.api = (path) => {
    reads.push(path);
    if (path === 'catalog/categories') return { kind: 'ok', body: TREE };
    const params = new URLSearchParams(path.split('?')[1]);
    const category = params.get('category');
    if (category !== null && emptyCategories.includes(category))
      return { kind: 'ok', body: { items: [], hasMore: false } };
    const page = Number(params.get('page'));
    const items =
      page <= pages ? Array.from({ length: perPage }, (_, i) => item(page * 100 + i)) : [];
    return { kind: 'ok', body: { items, hasMore: page < pages } };
  };
  return reads;
}

const locs = async (response: Response): Promise<string[]> =>
  [...(await response.text()).matchAll(/<loc>([^<]*)<\/loc>/gu)].map((m) => m[1] ?? '');

beforeEach(() => {
  clearSitemapCache();
  vi.stubEnv('STOREFRONT_INDEXING', 'on');
  request.host = 'shop.example';
  request.sampleData = false;
  request.api = () => ({ kind: 'failed' });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('robots.txt with indexing on', () => {
  const body = async (): Promise<string> => resolveRobots(await robots());

  it('blocks private pages and filter or sort URLs, and names the sitemap of the host', async () => {
    const text = await body();
    for (const path of ['/search', '/cart', '/checkout', '/account'])
      for (const rule of [`${path}$`, `${path}/`, `${path}?`])
        expect(text).toContain(`Disallow: ${rule}\n`);
    expect(text).not.toMatch(/^Disallow: \/(search|cart|checkout|account)\n/mu);
    for (const name of ['sort', 'special', 'sameday', 'low', 'cert', 'seller', 'price', 'new'])
      expect(text).toContain(`Disallow: /*?${name}=\n`);
    expect(text).toContain('Disallow: /*&sort=\n');
    expect(text).toContain('Sitemap: https://shop.example/sitemap.xml');
  });

  it('keeps paged listings crawlable', async () => {
    expect(await body()).not.toMatch(/page/u);
  });

  it('never disallows the whole site', async () => {
    expect(await body()).not.toMatch(/^Disallow: \/$/mu);
  });

  it('gives an unknown host no Sitemap line', async () => {
    request.host = 'unknown.example';
    const text = await body();
    expect(text).not.toContain('Sitemap:');
    expect(text).toContain('Disallow: /search');
  });

  it.each(['shop.example:8443', 'shop.example<x>', 'shop.example evil', ''])(
    'gives the Host %j no Sitemap line',
    async (host) => {
      request.host = host;
      expect(await body()).not.toContain('Sitemap:');
    },
  );

  it.each(['SHOP.example', 'shop.example.'])(
    'names the configured origin, not the typed Host %j',
    async (host) => {
      request.host = host;
      expect(await body()).toContain('Sitemap: https://shop.example/sitemap.xml');
    },
  );

  it('gives a host of another Market no Sitemap line', async () => {
    request.host = 'nz.example';
    expect(await body()).not.toContain('Sitemap:');
  });

  it('adds no rule and no Sitemap line while indexing is off', async () => {
    vi.stubEnv('STOREFRONT_INDEXING', 'off');
    expect(await body()).toBe('User-Agent: *\nAllow: /\n\n');
  });

  it('adds no rule while the storefront runs on sample data', async () => {
    request.sampleData = true;
    expect(await body()).toBe('User-Agent: *\nAllow: /\n\n');
  });
});

describe('sitemap answers', () => {
  const child = (name: string) =>
    childRoute(new Request('https://shop.example/'), {
      params: Promise.resolve({ name }),
    });

  it('is 404 while indexing is off', async () => {
    serve();
    vi.stubEnv('STOREFRONT_INDEXING', 'off');
    expect((await indexRoute()).status).toBe(404);
    expect((await child('pages.xml')).status).toBe(404);
  });

  it('is 404 on sample data', async () => {
    serve();
    request.sampleData = true;
    expect((await indexRoute()).status).toBe(404);
  });

  it('is 404 for an unknown host and for another Market', async () => {
    serve();
    for (const host of ['unknown.example', 'nz.example', null]) {
      request.host = host;
      expect((await indexRoute()).status).toBe(404);
      expect((await child('categories.xml')).status).toBe(404);
    }
  });

  it('is 503 when a read fails, never an empty sitemap', async () => {
    request.api = () => ({ kind: 'failed', status: 500 });
    expect((await indexRoute()).status).toBe(503);
    expect((await child('categories.xml')).status).toBe(503);
    expect((await child('products-1.xml')).status).toBe(503);
  });

  it('is 503 when the product search fails after the tree is read', async () => {
    request.api = (path) =>
      path === 'catalog/categories' ? { kind: 'ok', body: TREE } : { kind: 'failed' };
    expect((await indexRoute()).status).toBe(503);
  });

  it('is 404 for a child that does not exist', async () => {
    serve();
    for (const name of ['nope.xml', 'products-0.xml', 'products-6.xml', 'products-1', '..%2Fx.xml'])
      expect((await child(name)).status).toBe(404);
  });

  it('is XML that nobody caches', async () => {
    serve();
    const response = await indexRoute();
    expect(response.headers.get('content-type')).toContain('application/xml');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('sitemap index', () => {
  it('lists the pages, the categories and the product children that have products', async () => {
    serve({ pages: 1 });
    expect(await locs(await indexRoute())).toEqual([
      'https://shop.example/sitemaps/pages.xml',
      'https://shop.example/sitemaps/categories.xml',
      'https://shop.example/sitemaps/products-1.xml',
    ]);
  });

  it('lists no product child while there are no products', async () => {
    serve({ pages: 0 });
    expect(await locs(await indexRoute())).toHaveLength(2);
  });

  it('lists a second product child once the first is full', async () => {
    serve({ pages: 21 });
    expect((await locs(await indexRoute())).slice(2)).toEqual([
      'https://shop.example/sitemaps/products-1.xml',
      'https://shop.example/sitemaps/products-2.xml',
    ]);
  });
});

describe('sitemap children', () => {
  const child = (name: string) =>
    childRoute(new Request('https://shop.example/'), {
      params: Promise.resolve({ name }),
    });

  it('lists the home page and the sellers list, and no private page', async () => {
    serve();
    const urls = await locs(await child('pages.xml'));
    expect(urls).toEqual(['https://shop.example/', 'https://shop.example/sellers']);
  });

  it('lists categories that have products, and never an empty one', async () => {
    serve();
    expect(await locs(await child('categories.xml'))).toEqual([
      'https://shop.example/c/meat',
      'https://shop.example/c/meat/lamb',
    ]);
  });

  it('reads the category tree once for the whole child', async () => {
    const reads = serve();
    await child('categories.xml');
    expect(reads.filter((path) => path === 'catalog/categories')).toHaveLength(1);
  });

  it('lists products by their card link, once each, on the request origin', async () => {
    serve({ pages: 2, perPage: 2 });
    const urls = await locs(await child('products-1.xml'));
    expect(urls).toHaveLength(4);
    expect(urls.every((url) => url.startsWith('https://shop.example/p/'))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('lists the descriptive path /p/<name>-<id>, the same as the product card link', async () => {
    serve({ pages: 1, perPage: 2 });
    const urls = await locs(await child('products-1.xml'));
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const match =
        /^https:\/\/shop\.example\/p\/product-(\d+)-(0{8}-0000-4000-8000-\d{12})$/u.exec(url);
      expect(match).not.toBeNull();
      // The name part is the product's name as the search read gives it.
      expect(url).toBe(`https://shop.example${productHref(match![2]!, `Product ${match![1]!}`)}`);
    }
  });

  it('stops paging at hasMore false', async () => {
    const reads = serve({ pages: 3 });
    await child('products-1.xml');
    expect(reads.filter((path) => path.startsWith('search/products'))).toHaveLength(3);
  });

  it('lists no search, cart, checkout, account, filtered or seller URL', async () => {
    serve({ pages: 2 });
    const urls = [
      ...(await locs(await child('pages.xml'))),
      ...(await locs(await child('categories.xml'))),
      ...(await locs(await child('products-1.xml'))),
    ];
    for (const url of urls) {
      expect(url).not.toMatch(/\/(search|cart|checkout|account|l)(\/|$)|\/s\/|[?&]/u);
    }
    expect(urls.some((url) => /\/sellers$/u.test(url))).toBe(true);
  });

  it('stops at the cap, with one log line that points to package 4B', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const reads = serve({ pages: 500, perPage: 1 });
    const urls = await locs(await child('products-5.xml'));
    expect(urls).toHaveLength(20);
    expect(reads.filter((path) => path.startsWith('search/products')).at(-1)).toContain('page=100');
    const caps = log.mock.calls.filter(([line]) => String(line).includes('sitemap-product-cap'));
    expect(caps).toHaveLength(1);
  });

  it('logs nothing when the catalogue ends before the cap', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    serve({ pages: 3 });
    await child('products-1.xml');
    expect(
      log.mock.calls.filter(([line]) => String(line).includes('sitemap-product-cap')),
    ).toHaveLength(0);
  });

  it('escapes what it prints', async () => {
    serve();
    const text = await (await child('categories.xml')).text();
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/u);
    expect(text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(text).not.toMatch(/lastmod|priority|changefreq/u);
  });
});

describe('sitemap host and cache', () => {
  const child = (name: string) =>
    childRoute(new Request('https://shop.example/'), { params: Promise.resolve({ name }) });

  it.each(['shop.example:8443', 'shop.example<x>', 'shop.example evil', 'shop.example.evil'])(
    'answers 404 for the Host %j',
    async (host) => {
      serve();
      request.host = host;
      expect((await indexRoute()).status).toBe(404);
      expect((await child('pages.xml')).status).toBe(404);
    },
  );

  it('accepts the listed host in other case or with a trailing dot', async () => {
    serve();
    for (const host of ['SHOP.EXAMPLE', 'shop.example.']) {
      request.host = host;
      expect((await child('pages.xml')).status).toBe(200);
    }
  });

  it('reads the API once for repeated fetches inside the cache time', async () => {
    const reads = serve({ pages: 2 });
    await child('products-1.xml');
    const first = reads.length;
    await child('products-1.xml');
    await indexRoute();
    await indexRoute();
    expect(reads.length - first).toBeLessThanOrEqual(3);
    const again = reads.length;
    await indexRoute();
    expect(reads.length).toBe(again);
  });

  it('reads again after the cache time', async () => {
    vi.useFakeTimers();
    try {
      const reads = serve();
      await child('categories.xml');
      const first = reads.length;
      vi.advanceTimersByTime(CACHE_MS + 1);
      await child('categories.xml');
      expect(reads.length).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not keep a failure', async () => {
    request.api = () => ({ kind: 'failed', status: 500 });
    expect((await child('categories.xml')).status).toBe(503);
    serve();
    expect((await child('categories.xml')).status).toBe(200);
  });

  it('checks the switch on every request, cached or not', async () => {
    serve();
    expect((await child('pages.xml')).status).toBe(200);
    vi.stubEnv('STOREFRONT_INDEXING', 'off');
    expect((await child('pages.xml')).status).toBe(404);
  });
});
