import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRead } from '../src/storefront/api.ts';

// SEO package 5 follow-up: the proxy answers a product or store path with no page itself. It
// rewrites to the internal route that renders the 404 body on the server and sets 404 (Next 16
// sends a page's own notFound() as an empty shell). Pages that exist, closed stores and failed
// reads are left to the page; a client can never set the header that unlocks the internal route.

const ID = '3f2b8c1e-9a4d-4e6b-8f10-2d7c5a9b0e11';
const answers = new Map<string, ApiRead<unknown>>();
const asked: string[] = [];
const world = vi.hoisted(() => ({ api: true }));

vi.mock('../src/storefront/config.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  storefrontApiConfig: () =>
    world.api
      ? {
          apiBaseUrl: 'https://api.shop.example',
          hosts: [{ origin: 'https://shop.example', host: 'shop.example', marketId: 'AU' }],
          clientAddressKey: null,
        }
      : null,
}));
vi.mock('../src/storefront/api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiGetWith: (_config: unknown, _headers: unknown, path: string) => {
    asked.push(path);
    return Promise.resolve(
      answers.get(path) ?? (world.api ? { kind: 'ok', body: {} } : { kind: 'off' }),
    );
  },
}));

const { proxy } = await import('../proxy.ts');

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://shop.example${path}`, { headers });
const gone: ApiRead<unknown> = { kind: 'failed', status: 404 };
const noStore: ApiRead<unknown> = { kind: 'failed', status: 404, code: 'sellers.store-not-found' };
const rewrittenTo = (response: Response) => response.headers.get('x-middleware-rewrite');

beforeEach(() => {
  answers.clear();
  asked.length = 0;
  world.api = true;
});

describe('a product path with no page, API on', () => {
  it('rewrites to the internal route with status 404', async () => {
    answers.set(`search/product-detail/${ID}`, gone);

    const response = await proxy(request(`/p/old-name-${ID}`));

    expect(response.status).toBe(404);
    expect(rewrittenTo(response)).toBe(`http://shop.example/missing/p/old-name-${ID}`);
    expect(asked).toEqual([`search/product-detail/${ID}`]);
  });

  it('rewrites a segment with no id without a read', async () => {
    const response = await proxy(request('/p/no-such-product'));

    expect(response.status).toBe(404);
    expect(rewrittenTo(response)).toBe('http://shop.example/missing/p/no-such-product');
    expect(asked).toEqual([]);
  });

  it('leaves a product that exists, and a failed read, to the page', async () => {
    const found = await proxy(request(`/p/halal-lamb-${ID}`));
    expect(found.status).toBe(200);
    expect(rewrittenTo(found)).toBeNull();

    answers.set(`search/product-detail/${ID}`, { kind: 'failed', status: 503 });
    const outage = await proxy(request(`/p/halal-lamb-${ID}`));
    expect(outage.status).toBe(200);
    expect(rewrittenTo(outage)).toBeNull();
  });
});

describe('a store path with no page', () => {
  it("rewrites an unknown store with the store module's own 404 code", async () => {
    answers.set('sellers/stores/no-such-store', noStore);

    const response = await proxy(request('/s/no-such-store'));

    expect(response.status).toBe(404);
    expect(rewrittenTo(response)).toBe('http://shop.example/missing/s/no-such-store');
  });

  it('leaves a bare 404 (a missing route) and a store that exists to the page', async () => {
    answers.set('sellers/stores/a-store', gone);
    expect(rewrittenTo(await proxy(request('/s/a-store')))).toBeNull();
    answers.set('sellers/stores/kedron', { kind: 'ok', body: {} });
    expect(rewrittenTo(await proxy(request('/s/kedron')))).toBeNull();
  });

  it('does not touch the store image route or other paths', async () => {
    expect(rewrittenTo(await proxy(request('/s/kedron/images/x/logo')))).toBeNull();
    expect(rewrittenTo(await proxy(request('/cart')))).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('the sample data (no API)', () => {
  it('rewrites the removed product and the unknown store, leaves sample pages and a closed store', async () => {
    world.api = false;
    expect(rewrittenTo(await proxy(request('/p/lamb-leg-roast')))).toBe(
      'http://shop.example/missing/p/lamb-leg-roast',
    );
    expect(rewrittenTo(await proxy(request('/p/no-such-product')))).not.toBeNull();
    expect(rewrittenTo(await proxy(request('/s/no-such-store')))).not.toBeNull();
    expect(rewrittenTo(await proxy(request('/p/lamb-shoulder')))).toBeNull();
    expect(rewrittenTo(await proxy(request('/s/kedron')))).toBeNull();
    expect(rewrittenTo(await proxy(request('/s/west-end-grocer')))).toBeNull();
  });
});

describe('a client request for the internal route', () => {
  it('goes to /missing, which has no page, so it is the framework 404 and never a 200 page', async () => {
    for (const path of ['/missing/p/lamb-shoulder', '/missing/s/kedron', '/missing']) {
      const response = await proxy(request(path));
      expect(response.status).toBe(404);
      expect(rewrittenTo(response)).toBe('http://shop.example/missing');
    }
    expect(asked).toEqual([]);
  });
});
