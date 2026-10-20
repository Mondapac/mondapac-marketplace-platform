import { describe, expect, it, vi } from 'vitest';
import { relay } from '../src/storefront/bff.ts';
import type { StorefrontApiConfig } from '../src/storefront/config.ts';

// The buyer site's relay of the customer's own routes (ADR-0034 decision 3, as the panels'):
// allowlist, Market from the host, same-origin unsafe requests only, cookies relayed unchanged.

const ORIGIN = 'http://storefront.localhost:3003';
const config: StorefrontApiConfig = {
  apiBaseUrl: 'http://api.test',
  hosts: [{ origin: ORIGIN, host: 'storefront.localhost:3003', marketId: 'AU' }],
  clientAddressKey: null,
};
const sameOrigin = {
  host: 'storefront.localhost:3003',
  origin: ORIGIN,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};
const ID = '01990000-0000-7000-8000-000000000abc';

const request = (method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Request(`${ORIGIN}/api/${path}`, { method, headers, ...(body ? { body } : {}) });
const ok = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"code":"ok"}', { status: 200 })));
const quiet = () => undefined;

describe('storefront relay', () => {
  it('relays nothing while API_BASE_URL is empty (sample data)', async () => {
    const upstream = ok();
    const answer = await relay(
      null,
      request('GET', 'identity/customer/session', sameOrigin),
      ['identity', 'customer', 'session'],
      upstream,
      quiet,
    );
    expect(answer.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', 'identity/customer/session'],
    ['POST', 'identity/customer/sign-in'],
    ['POST', 'identity/customer/sign-out'],
    ['POST', 'identity/customer/change-password'],
    ['PUT', 'identity/customer/profile/display-name'],
    ['PUT', 'identity/customer/profile/appearance'],
    ['GET', 'customers/me/addresses'],
    ['POST', 'customers/me/addresses'],
    ['PUT', `customers/me/addresses/${ID}`],
    ['DELETE', `customers/me/addresses/${ID}`],
    ['POST', `customers/me/addresses/${ID}/default`],
  ])('relays %s %s with the Market of the host', async (method, path) => {
    const upstream = ok();
    const answer = await relay(
      config,
      request(method, path, sameOrigin, method === 'GET' ? undefined : '{}'),
      path.split('/'),
      upstream,
      quiet,
    );
    expect(answer.status).toBe(200);
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe(`http://api.test/${path}`);
    expect(new Headers(init?.headers).get('x-market-id')).toBe('AU');
  });

  it.each([
    ['GET', 'identity/customer/profile/appearance'],
    ['POST', 'identity/seller/sign-up'],
    ['GET', 'identity/admin/session'],
    ['PUT', 'customers/me/addresses/not-a-uuid'],
    ['PUT', `customers/me/addresses/${ID}/extra`],
    ['GET', 'docs-json'],
    ['GET', 'health'],
  ])('refuses %s %s with 404', async (method, path) => {
    const upstream = ok();
    const answer = await relay(
      config,
      request(method, path, sameOrigin, method === 'GET' ? undefined : '{}'),
      path.split('/'),
      upstream,
      quiet,
    );
    expect(answer.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers 404 for a host that is not listed', async () => {
    const upstream = ok();
    const answer = await relay(
      config,
      request('GET', 'identity/customer/session', { ...sameOrigin, host: 'evil.localhost:3003' }),
      ['identity', 'customer', 'session'],
      upstream,
      quiet,
    );
    expect(answer.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: 'https://evil.example' },
    { origin: 'http://storefront.localhost:3004' },
  ])('refuses an unsafe request that is not same-origin: %j', async (override) => {
    const upstream = ok();
    const answer = await relay(
      config,
      request('PUT', 'identity/customer/profile/appearance', { ...sameOrigin, ...override }, '{}'),
      ['identity', 'customer', 'profile', 'appearance'],
      upstream,
      quiet,
    );
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ statusCode: 403, code: 'request.csrf' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses an unsafe request with no origin headers at all', async () => {
    const upstream = ok();
    const answer = await relay(
      config,
      request('POST', 'identity/customer/sign-out', { host: 'storefront.localhost:3003' }, '{}'),
      ['identity', 'customer', 'sign-out'],
      upstream,
      quiet,
    );
    expect(answer.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses an Authorization header', async () => {
    const upstream = ok();
    const answer = await relay(
      config,
      request('GET', 'identity/customer/session', { ...sameOrigin, authorization: 'Bearer x' }),
      ['identity', 'customer', 'session'],
      upstream,
      quiet,
    );
    expect(answer.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards only the allowlisted headers and drops the query', async () => {
    const upstream = ok();
    await relay(
      config,
      new Request(`${ORIGIN}/api/identity/customer/session?x=1`, {
        headers: {
          ...sameOrigin,
          cookie: '__Host-session-customer-AU=ms1_abc',
          'x-csrf-token': 'token',
          'x-market-id': 'ZZ',
          'x-client-address': 'forged',
          'x-forwarded-for': '203.0.113.9',
        },
      }),
      ['identity', 'customer', 'session'],
      upstream,
      quiet,
    );
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('http://api.test/identity/customer/session');
    const sent = new Headers(init?.headers);
    expect(sent.get('cookie')).toBe('__Host-session-customer-AU=ms1_abc');
    expect(sent.get('x-csrf-token')).toBe('token');
    expect(sent.get('x-market-id')).toBe('AU');
    expect(sent.get('x-client-address')).toBeNull();
    expect(sent.get('x-forwarded-for')).toBeNull();
  });

  it('relays every Set-Cookie unchanged and defaults to no-store', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', '__Host-session-customer-AU=ms1_a; Path=/; Secure; HttpOnly');
    headers.append('set-cookie', 'other=1; Path=/; Secure');
    const answer = await relay(
      config,
      request('POST', 'identity/customer/sign-in', sameOrigin, '{}'),
      ['identity', 'customer', 'sign-in'],
      () => Promise.resolve(new Response('{"code":"signed-in"}', { status: 200, headers })),
      quiet,
    );
    expect(answer.headers.getSetCookie()).toEqual([
      '__Host-session-customer-AU=ms1_a; Path=/; Secure; HttpOnly',
      'other=1; Path=/; Secure',
    ]);
    expect(answer.headers.get('cache-control')).toBe('private, no-store');
  });

  it('refuses a body over the cap and answers 503 when the API is unreachable', async () => {
    const big = await relay(
      config,
      request('POST', 'customers/me/addresses', sameOrigin, 'x'.repeat(17 * 1024)),
      ['customers', 'me', 'addresses'],
      ok(),
      quiet,
    );
    expect(big.status).toBe(413);
    const log = vi.fn();
    const down = await relay(
      config,
      request('GET', 'customers/me/addresses', { ...sameOrigin, cookie: 'secret=1' }),
      ['customers', 'me', 'addresses'],
      () => Promise.reject(new Error('down')),
      log,
    );
    expect(down.status).toBe(503);
    expect(log).toHaveBeenCalledWith({
      msg: 'storefront.relay.upstream-unreachable',
      method: 'GET',
      path: 'customers/me/addresses',
      marketId: 'AU',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret=1');
  });
});
