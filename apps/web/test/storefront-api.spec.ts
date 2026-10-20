import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGetWith } from '../src/storefront/api.ts';
import {
  assertClientAddressForwarding,
  parseStorefrontApiConfig,
  storefrontHostFor,
  type StorefrontApiConfig,
} from '../src/storefront/config.ts';

const SECRET = Buffer.alloc(32, 7).toString('base64');
const LOCAL = {
  API_BASE_URL: 'http://localhost:3000',
  STOREFRONT_HOSTS: 'http://storefront.localhost:3003=AU,http://nz.localhost:3003=NZ',
};
const SIGNED = {
  ...LOCAL,
  BFF_CLIENT_ADDRESS_KEY_ID: 'storefront',
  BFF_CLIENT_ADDRESS_SECRET: SECRET,
};

const config = (env: Readonly<Record<string, string>>) =>
  parseStorefrontApiConfig(env) as StorefrontApiConfig;

const incoming = (values: Readonly<Record<string, string>>) => new Headers(values);

function serve(status = 200, body: unknown = { items: [] }) {
  const calls: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return Promise.resolve(Response.json(body, { status }));
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('storefront API configuration', () => {
  it('is off while API_BASE_URL is empty, so every page keeps its sample', () => {
    expect(parseStorefrontApiConfig({})).toBeNull();
    expect(parseStorefrontApiConfig({ API_BASE_URL: '  ' })).toBeNull();
  });

  it('maps each listed host to its Market and has no default Market', () => {
    const parsed = config(LOCAL);
    expect(parsed.apiBaseUrl).toBe('http://localhost:3000');
    expect(storefrontHostFor(parsed, 'storefront.localhost:3003')?.marketId).toBe('AU');
    expect(storefrontHostFor(parsed, 'NZ.localhost:3003')?.marketId).toBe('NZ');
    expect(storefrontHostFor(parsed, 'storefront.localhost.:3003')?.marketId).toBe('AU');
    expect(storefrontHostFor(parsed, 'localhost:3003')).toBeUndefined();
    expect(storefrontHostFor(parsed, null)).toBeUndefined();
  });

  it('refuses a malformed configuration at start-up', () => {
    expect(() => parseStorefrontApiConfig({ API_BASE_URL: 'http://localhost:3000' })).toThrow(
      /STOREFRONT_HOSTS is required/,
    );
    expect(() => parseStorefrontApiConfig({ ...LOCAL, API_BASE_URL: 'http://api/v1' })).toThrow(
      /origin with no path/,
    );
    expect(() => parseStorefrontApiConfig({ ...LOCAL, API_BASE_URL: 'ftp://api' })).toThrow(
      /origin with no path/,
    );
    expect(() =>
      parseStorefrontApiConfig({ ...LOCAL, STOREFRONT_HOSTS: 'http://a.localhost=au' }),
    ).toThrow(/not a Market code/);
    expect(() =>
      parseStorefrontApiConfig({ ...LOCAL, STOREFRONT_HOSTS: 'http://a.localhost/x=AU' }),
    ).toThrow(/no path/);
    expect(() =>
      parseStorefrontApiConfig({
        ...LOCAL,
        STOREFRONT_HOSTS: 'http://a.localhost=AU,http://a.localhost=NZ',
      }),
    ).toThrow(/listed twice/);
    expect(() =>
      parseStorefrontApiConfig({ ...LOCAL, BFF_CLIENT_ADDRESS_KEY_ID: 'storefront' }),
    ).toThrow(/must be set together/);
  });

  it('needs a signing key on a real host, never on *.localhost', () => {
    expect(() => assertClientAddressForwarding(config(LOCAL))).not.toThrow();
    const real = { ...LOCAL, STOREFRONT_HOSTS: 'https://mondapac.com.au=AU' };
    expect(() => assertClientAddressForwarding(config(real))).toThrow(/must sign/);
    expect(() =>
      assertClientAddressForwarding(config({ ...SIGNED, STOREFRONT_HOSTS: real.STOREFRONT_HOSTS })),
    ).not.toThrow();
  });
});

describe('storefront API read', () => {
  it('answers off without calling anything when the API is not configured', async () => {
    const calls = serve();
    expect(await apiGetWith(null, incoming({}), 'catalog/categories')).toEqual({ kind: 'off' });
    expect(calls).toHaveLength(0);
  });

  it("sends the host's Market and never the buyer's cookie", async () => {
    const calls = serve(200, { ok: 1 });
    const read = await apiGetWith(
      config(LOCAL),
      incoming({ host: 'nz.localhost:3003', cookie: 'mp_session=secret' }),
      'search/specials?limit=4',
    );
    expect(read).toEqual({ kind: 'ok', body: { ok: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://localhost:3000/search/specials?limit=4');
    expect(calls[0]!.headers.get('x-market-id')).toBe('NZ');
    expect(calls[0]!.headers.get('cookie')).toBeNull();
    expect(calls[0]!.headers.get('x-client-address')).toBeNull();
  });

  it('signs the address server.mjs set, for the Market of the host', async () => {
    const calls = serve();
    await apiGetWith(
      config(SIGNED),
      incoming({ host: 'storefront.localhost:3003', 'x-mp-client-address': '203.0.113.9' }),
      'catalog/categories',
      () => 1_760_000_000_000,
    );
    expect(calls[0]!.headers.get('x-client-address')).toMatch(
      /^v1;k=storefront;t=1760000000;a=203\.0\.113\.9;s=[A-Za-z0-9_-]+$/,
    );
  });

  it('sends nothing unsigned when the request did not come through server.mjs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const calls = serve();
    const read = await apiGetWith(
      config(SIGNED),
      incoming({ host: 'storefront.localhost:3003' }),
      'catalog/categories',
    );
    expect(read).toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        msg: 'storefront.api-read-failed',
        path: 'catalog/categories',
        error: 'client-address-missing',
      }),
    );
  });

  it('reads nothing for a host that is not listed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const calls = serve();
    const read = await apiGetWith(
      config(LOCAL),
      incoming({ host: 'evil.test' }),
      'catalog/categories',
    );
    expect(read).toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(0);
  });

  it('turns a refusal, a network error and a timeout into failed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const host = incoming({ host: 'storefront.localhost:3003' });
    serve(503);
    expect(await apiGetWith(config(LOCAL), host, 'search/bestsellers')).toEqual({
      kind: 'failed',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    expect(await apiGetWith(config(LOCAL), host, 'search/bestsellers')).toEqual({
      kind: 'failed',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))),
    );
    expect(await apiGetWith(config(LOCAL), host, 'search/bestsellers')).toEqual({
      kind: 'failed',
    });
    expect(log.mock.calls.map((c): unknown => c[0])).toEqual([
      JSON.stringify({
        msg: 'storefront.api-read-refused',
        path: 'search/bestsellers',
        status: 503,
      }),
      JSON.stringify({
        msg: 'storefront.api-read-failed',
        path: 'search/bestsellers',
        error: 'TypeError',
      }),
      JSON.stringify({
        msg: 'storefront.api-read-failed',
        path: 'search/bestsellers',
        error: 'TimeoutError',
      }),
    ]);
  });

  it('replaces an x-client-address the browser sent with the signed one', async () => {
    const calls = serve();
    await apiGetWith(
      config(SIGNED),
      incoming({
        host: 'storefront.localhost:3003',
        'x-mp-client-address': '203.0.113.9',
        'x-client-address': 'v1;k=storefront;t=1;a=198.51.100.1;s=forged',
      }),
      'catalog/categories',
    );
    expect(calls[0]!.headers.get('x-client-address')).toMatch(/;a=203\.0\.113\.9;/);
    expect(calls[0]!.headers.get('x-client-address')).not.toContain('forged');
  });

  it.each([
    '/catalog/categories',
    '../admin/x',
    'storefront/pages/%2e%2e/%2E%2E/admin',
    'storefront/pages/../../admin',
    'storefront\\pages',
    'storefront/pages/home#x',
    'storefront/pages/a b',
  ])('reads nothing for a path that could leave its route: %s', async (path) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const calls = serve();
    expect(
      await apiGetWith(config(LOCAL), incoming({ host: 'storefront.localhost:3003' }), path),
    ).toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ msg: 'storefront.api-read-bad-path' }));
  });

  it('logs the route without its query', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    serve(500);
    await apiGetWith(
      config(LOCAL),
      incoming({ host: 'storefront.localhost:3003' }),
      'search/products?q=private%20words',
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ msg: 'storefront.api-read-refused', path: 'search/products', status: 500 }),
    );
  });
});
