import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStorefrontApiConfig, type StorefrontApiConfig } from '../src/storefront/config.ts';
import { sessionGetWith } from '../src/storefront/session.ts';
import {
  isSessionPathAllowed,
  relaySession,
  upstreamCookie,
  type RelayLog,
} from '../src/storefront/session-relay.ts';

const SECRET = Buffer.alloc(32, 7).toString('base64');
const CONFIG = parseStorefrontApiConfig({
  API_BASE_URL: 'http://localhost:3000',
  STOREFRONT_HOSTS: 'http://storefront.localhost:3003=AU,http://nz.localhost:3003=NZ',
  BFF_CLIENT_ADDRESS_KEY_ID: 'storefront',
  BFF_CLIENT_ADDRESS_SECRET: SECRET,
}) as StorefrontApiConfig;

const MARKETS = [
  { marketId: 'AU', host: 'storefront.localhost:3003', origin: 'http://storefront.localhost:3003' },
  { marketId: 'NZ', host: 'nz.localhost:3003', origin: 'http://nz.localhost:3003' },
] as const;

const LINE = '0f8fad5b-d9cb-469f-a165-70867728950e';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

/** A fake API: answers by `METHOD path`, records every call. */
function api(answers: Readonly<Record<string, () => Response>>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn((url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const answer = answers[`${method} ${new URL(url).pathname.slice(1)}`];
    return Promise.resolve(answer === undefined ? new Response(null, { status: 404 }) : answer());
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function browser(
  market: (typeof MARKETS)[number],
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit } = {},
): Request {
  const unsafe = method !== 'GET';
  return new Request(`${market.origin}/api/${path}`, {
    method,
    headers: {
      host: market.host,
      'x-mp-client-address': '203.0.113.9',
      ...(unsafe
        ? {
            origin: market.origin,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
          }
        : {}),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: init.body, duplex: 'half' }),
  });
}

const silent: RelayLog = () => undefined;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storefront session relay: what may cross', () => {
  it('allows only the cart and customer-session paths, each with its own method', () => {
    expect(isSessionPathAllowed('GET', ['cart'])).toBe(true);
    expect(isSessionPathAllowed('GET', ['identity', 'customer', 'session'])).toBe(true);
    expect(isSessionPathAllowed('POST', ['cart', 'items'])).toBe(true);
    expect(isSessionPathAllowed('POST', ['cart', 'merge'])).toBe(true);
    expect(isSessionPathAllowed('POST', ['identity', 'customer', 'sign-in'])).toBe(true);
    expect(isSessionPathAllowed('PUT', ['cart', 'items', LINE])).toBe(true);
    expect(isSessionPathAllowed('DELETE', ['cart', 'items', LINE])).toBe(true);

    expect(isSessionPathAllowed('POST', ['cart'])).toBe(false);
    expect(isSessionPathAllowed('PUT', ['cart', 'items', 'not-a-uuid'])).toBe(false);
    expect(isSessionPathAllowed('PUT', ['cart', 'items', LINE, 'x'])).toBe(false);
    expect(isSessionPathAllowed('GET', ['identity', 'seller', 'session'])).toBe(false);
    expect(isSessionPathAllowed('GET', ['identity', 'customer', 'change-password'])).toBe(false);
    expect(isSessionPathAllowed('GET', ['ordering', 'orders'])).toBe(false);
    expect(isSessionPathAllowed('PATCH', ['cart', 'items', LINE])).toBe(false);
  });

  it.each(MARKETS)(
    'answers 404 for a path off the list, without calling the API ($marketId)',
    async (market) => {
      const { calls, fetchImpl } = api({});
      const response = await relaySession(
        CONFIG,
        browser(market, 'GET', 'identity/customer/account'),
        ['identity', 'customer', 'account'],
        fetchImpl,
        silent,
      );
      expect(response.status).toBe(404);
      expect(calls).toHaveLength(0);
    },
  );

  it('answers 404 for a host that is not listed and 503 while the API is off', async () => {
    const { calls, fetchImpl } = api({});
    const unknown = new Request('http://evil.localhost:3003/api/cart', {
      headers: { host: 'evil.localhost:3003' },
    });
    expect((await relaySession(CONFIG, unknown, ['cart'], fetchImpl, silent)).status).toBe(404);
    const off = await relaySession(null, browser(MARKETS[0], 'GET', 'cart'), ['cart'], fetchImpl);
    expect(off.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it.each(MARKETS)(
    'sends only the Market session and guest-cart cookies, with the Market and signed address ($marketId)',
    async (market) => {
      const { calls, fetchImpl } = api({ 'GET cart': () => Response.json({ lineCount: 2 }) });
      const other = market.marketId === 'AU' ? 'NZ' : 'AU';
      await relaySession(
        CONFIG,
        browser(market, 'GET', 'cart', {
          headers: {
            cookie: [
              `sf-consent=v1.granted`,
              `__Host-session-customer-${market.marketId}=s1`,
              `__Host-session-customer-${other}=elsewhere`,
              `__Host-engagement-guest-${market.marketId}=e1`,
              `__Host-cart-guest-${market.marketId}=g1`,
              `__Host-session-seller-${market.marketId}=seller`,
            ].join('; '),
            'x-forwarded-for': '198.51.100.1',
          },
        }),
        ['cart'],
        fetchImpl,
        silent,
      );
      expect(calls).toHaveLength(1);
      const sent = calls[0] as Call;
      expect(sent.url).toBe('http://localhost:3000/cart');
      expect(sent.headers.get('cookie')).toBe(
        `__Host-session-customer-${market.marketId}=s1; __Host-cart-guest-${market.marketId}=g1`,
      );
      expect(sent.headers.get('x-market-id')).toBe(market.marketId);
      expect(sent.headers.get('x-client-address')).toMatch(/^v1;k=storefront;/u);
      expect(sent.headers.has('x-forwarded-for')).toBe(false);
      expect(sent.headers.has('x-mp-client-address')).toBe(false);
    },
  );

  it('sends no cookie header when the browser has neither cookie', () => {
    expect(upstreamCookie('sf-consent=v1; theme=b', 'AU')).toBeNull();
    expect(upstreamCookie(null, 'AU')).toBeNull();
  });

  it('drops a pair without a name or an equals sign, and keeps a repeated name repeated', () => {
    expect(upstreamCookie('__Host-cart-guest-AU; =__Host-cart-guest-AU=x', 'AU')).toBeNull();
    expect(upstreamCookie('__Host-cart-guest-AU=a; __Host-cart-guest-AU=b', 'AU')).toBe(
      '__Host-cart-guest-AU=a; __Host-cart-guest-AU=b',
    );
  });

  it.each([
    ['same-origin', 200],
    ['none', 200],
    [undefined, 200],
    ['same-site', 403],
    ['cross-site', 403],
  ])('a read with Sec-Fetch-Site %s answers %i', async (site, status) => {
    const { fetchImpl } = api({ 'GET cart': () => Response.json({ lineCount: 0 }) });
    const response = await relaySession(
      CONFIG,
      browser(MARKETS[0], 'GET', 'cart', {
        headers: site === undefined ? {} : { 'sec-fetch-site': site },
      }),
      ['cart'],
      fetchImpl,
      silent,
    );
    expect(response.status).toBe(status);
  });

  it.each(MARKETS)(
    'passes back only the Set-Cookie of the two cookies, never cached ($marketId)',
    async (market) => {
      const { fetchImpl } = api({
        'GET cart': () => {
          const headers = new Headers({ 'content-type': 'application/json', 'x-powered-by': 'x' });
          headers.append('set-cookie', `__Host-cart-guest-${market.marketId}=; Max-Age=0; Path=/`);
          headers.append('set-cookie', 'tracker=1; Path=/');
          headers.append('set-cookie', `__Host-session-admin-${market.marketId}=a; Path=/`);
          return new Response('{"lineCount":0}', { status: 200, headers });
        },
      });
      const response = await relaySession(
        CONFIG,
        browser(market, 'GET', 'cart'),
        ['cart'],
        fetchImpl,
        silent,
      );
      expect(response.headers.getSetCookie()).toEqual([
        `__Host-cart-guest-${market.marketId}=; Max-Age=0; Path=/`,
      ]);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.has('x-powered-by')).toBe(false);
      expect(await response.json()).toEqual({ lineCount: 0 });
    },
  );

  it('refuses a request that carries an Authorization header', async () => {
    const { calls, fetchImpl } = api({});
    const response = await relaySession(
      CONFIG,
      browser(MARKETS[0], 'GET', 'cart', { headers: { authorization: 'Bearer x' } }),
      ['cart'],
      fetchImpl,
      silent,
    );
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe('storefront session relay: writes', () => {
  const add = JSON.stringify({ offerId: LINE, variantId: LINE, quantity: 1 });

  it.each(MARKETS)(
    'passes a same-origin write with its CSRF token and origin headers ($marketId)',
    async (market) => {
      const { calls, fetchImpl } = api({ 'POST cart/items': () => Response.json({ ok: true }) });
      const response = await relaySession(
        CONFIG,
        browser(market, 'POST', 'cart/items', {
          headers: { 'x-csrf-token': 'csrf-1' },
          body: add,
        }),
        ['cart', 'items'],
        fetchImpl,
        silent,
      );
      expect(response.status).toBe(200);
      const sent = calls[0] as Call;
      expect(sent.method).toBe('POST');
      expect(sent.body).toBe(add);
      expect(sent.headers.get('x-csrf-token')).toBe('csrf-1');
      expect(sent.headers.get('origin')).toBe(market.origin);
      expect(sent.headers.get('sec-fetch-site')).toBe('same-origin');
    },
  );

  it.each([
    ['a cross-site request', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site request', { 'sec-fetch-site': 'same-site' }],
    ['another origin', { origin: 'http://nz.localhost:3003' }],
    ['the same host on another scheme', { origin: 'https://storefront.localhost:3003' }],
  ])('refuses %s with request.csrf before the API is called', async (_label, headers) => {
    const { calls, fetchImpl } = api({});
    const response = await relaySession(
      CONFIG,
      browser(MARKETS[0], 'POST', 'cart/items', { headers, body: add }),
      ['cart', 'items'],
      fetchImpl,
      silent,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ statusCode: 403, code: 'request.csrf' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a write without origin headers', async () => {
    const { calls, fetchImpl } = api({});
    const request = new Request('http://storefront.localhost:3003/api/cart/items', {
      method: 'POST',
      headers: { host: 'storefront.localhost:3003', 'content-type': 'application/json' },
      body: add,
    });
    const response = await relaySession(CONFIG, request, ['cart', 'items'], fetchImpl, silent);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a body over 16 KiB, declared or streamed', async () => {
    const { calls, fetchImpl } = api({});
    const big = 'x'.repeat(16 * 1024 + 1);
    const declared = await relaySession(
      CONFIG,
      browser(MARKETS[0], 'POST', 'cart/items', {
        headers: { 'content-length': String(big.length) },
        body: big,
      }),
      ['cart', 'items'],
      fetchImpl,
      silent,
    );
    expect(declared.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const streamed = await relaySession(
      CONFIG,
      browser(MARKETS[0], 'POST', 'cart/items', { body: stream }),
      ['cart', 'items'],
      fetchImpl,
      silent,
    );
    expect(streamed.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('answers 503 when the API cannot be reached, and logs no cookie', async () => {
    const lines: Record<string, string | number>[] = [];
    const fetchImpl = vi.fn(() => Promise.reject(new Error('down'))) as unknown as typeof fetch;
    const response = await relaySession(
      CONFIG,
      browser(MARKETS[0], 'GET', 'cart', { headers: { cookie: '__Host-cart-guest-AU=secret' } }),
      ['cart'],
      fetchImpl,
      (line) => lines.push(line),
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(lines)).not.toContain('secret');
  });
});

describe('storefront session relay: guest cart merge after sign-in', () => {
  const signIn = JSON.stringify({ email: 'buyer@example.test', password: 'pw' });

  function signedIn(marketId: string): Response {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append(
      'set-cookie',
      `__Host-session-customer-${marketId}=new-token; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    return new Response(JSON.stringify({ code: 'signed-in', csrfToken: 'csrf-new' }), {
      status: 200,
      headers,
    });
  }

  it.each(MARKETS)(
    'merges the guest cart into the new session and returns both cookies ($marketId)',
    async (market) => {
      const { calls, fetchImpl } = api({
        'POST identity/customer/sign-in': () => signedIn(market.marketId),
        'POST cart/merge': () => {
          const headers = new Headers({ 'content-type': 'application/json' });
          headers.append(
            'set-cookie',
            `__Host-cart-guest-${market.marketId}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
          );
          return new Response('{"merged":2,"clamped":[],"notAdded":[]}', { headers });
        },
      });
      const response = await relaySession(
        CONFIG,
        browser(market, 'POST', 'identity/customer/sign-in', {
          headers: { cookie: `sf-consent=v1; __Host-cart-guest-${market.marketId}=guest-token` },
          body: signIn,
        }),
        ['identity', 'customer', 'sign-in'],
        fetchImpl,
        silent,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ code: 'signed-in', csrfToken: 'csrf-new' });
      expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        'POST /identity/customer/sign-in',
        'POST /cart/merge',
      ]);
      const merge = calls[1] as Call;
      expect(merge.headers.get('cookie')).toBe(
        `__Host-session-customer-${market.marketId}=new-token; __Host-cart-guest-${market.marketId}=guest-token`,
      );
      expect(merge.headers.get('x-csrf-token')).toBe('csrf-new');
      expect(merge.headers.get('origin')).toBe(market.origin);
      expect(merge.headers.get('sec-fetch-site')).toBe('same-origin');
      expect(merge.headers.get('x-market-id')).toBe(market.marketId);
      expect(merge.headers.has('content-type')).toBe(false);
      expect(merge.body).toBeUndefined();
      const cookies = response.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toMatch(
        new RegExp(`^__Host-session-customer-${market.marketId}=new-token;`),
      );
      expect(cookies[1]).toMatch(new RegExp(`^__Host-cart-guest-${market.marketId}=;`));
    },
  );

  it('also merges after the email confirmation link signs in', async () => {
    const { calls, fetchImpl } = api({
      'POST identity/customer/confirm-email': () => signedIn('AU'),
      'POST cart/merge': () => Response.json({ merged: 0 }),
    });
    await relaySession(
      CONFIG,
      browser(MARKETS[0], 'POST', 'identity/customer/confirm-email', {
        headers: { cookie: '__Host-cart-guest-AU=guest-token' },
        body: JSON.stringify({ token: 't', password: 'pw' }),
      }),
      ['identity', 'customer', 'confirm-email'],
      fetchImpl,
      silent,
    );
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/identity/customer/confirm-email',
      '/cart/merge',
    ]);
  });

  it.each([
    ['refuses', () => Response.json({ code: 'conflict.stale' }, { status: 409 })],
    [
      'fails',
      () => {
        throw new Error('down');
      },
    ],
  ])('keeps the sign-in when the merge %s, and logs it', async (_label, merge) => {
    const lines: Record<string, string | number>[] = [];
    const { fetchImpl } = api({
      'POST identity/customer/sign-in': () => signedIn('AU'),
      'POST cart/merge': merge,
    });
    const response = await relaySession(
      CONFIG,
      browser(MARKETS[0], 'POST', 'identity/customer/sign-in', {
        headers: { cookie: '__Host-cart-guest-AU=guest-token' },
        body: signIn,
      }),
      ['identity', 'customer', 'sign-in'],
      fetchImpl,
      (line) => lines.push(line),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.getSetCookie()[0]).toMatch(/^__Host-session-customer-AU=new-token;/u);
    expect(lines.map((line) => line['msg'])).toEqual([
      expect.stringMatching(/^storefront\.session\.merge-(refused|failed)$/u),
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/guest-token|new-token|csrf-new/u);
  });

  it('does not merge without a guest cart, or when the sign-in is refused', async () => {
    const { calls, fetchImpl } = api({
      'POST identity/customer/sign-in': () => signedIn('AU'),
    });
    await relaySession(
      CONFIG,
      browser(MARKETS[0], 'POST', 'identity/customer/sign-in', { body: signIn }),
      ['identity', 'customer', 'sign-in'],
      fetchImpl,
      silent,
    );
    expect(calls).toHaveLength(1);

    const refused = api({
      'POST identity/customer/sign-in': () =>
        Response.json({ code: 'credentials.invalid' }, { status: 401 }),
    });
    const response = await relaySession(
      CONFIG,
      browser(MARKETS[0], 'POST', 'identity/customer/sign-in', {
        headers: { cookie: '__Host-cart-guest-AU=guest-token' },
        body: signIn,
      }),
      ['identity', 'customer', 'sign-in'],
      refused.fetchImpl,
      silent,
    );
    expect(response.status).toBe(401);
    expect(refused.calls).toHaveLength(1);
  });
});

describe('storefront session read from a page', () => {
  function serve(status: number, body: unknown) {
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
  });

  it.each(MARKETS)('reads with only the two cookies of the Market ($marketId)', async (market) => {
    const calls = serve(200, { lineCount: 3 });
    const read = await sessionGetWith(
      CONFIG,
      new Headers({ host: market.host, 'x-mp-client-address': '203.0.113.9' }),
      `sf-consent=v1; __Host-cart-guest-${market.marketId}=g; __Host-session-admin-${market.marketId}=a`,
      'cart',
    );
    expect(read).toEqual({ kind: 'ok', body: { lineCount: 3 } });
    expect(calls[0]?.url).toBe('http://localhost:3000/cart');
    expect(calls[0]?.headers.get('cookie')).toBe(`__Host-cart-guest-${market.marketId}=g`);
    expect(calls[0]?.headers.get('x-market-id')).toBe(market.marketId);
  });

  it('is off while the API is off, and failed for an ended session', async () => {
    expect(await sessionGetWith(null, new Headers(), null, 'cart')).toEqual({ kind: 'off' });
    serve(401, { code: 'session.invalid' });
    const read = await sessionGetWith(
      CONFIG,
      new Headers({ host: MARKETS[0].host, 'x-mp-client-address': '203.0.113.9' }),
      '__Host-session-customer-AU=old',
      'identity/customer/session',
    );
    expect(read).toEqual({ kind: 'failed', status: 401 });
  });
});
