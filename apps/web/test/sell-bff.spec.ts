import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStorefrontApiConfig, type StorefrontApiConfig } from '../src/storefront/config.ts';
import { parseSellerSignInUrls } from '../src/storefront/seller-sign-in.ts';
import {
  callSellerSignUp,
  mapSignUpAnswer,
  signUpHeaders,
} from '../src/storefront/seller-sign-up-api.ts';

// The storefront BFF's seller sign-up calls (PR #443's server path; Hassan's conditions from
// PR #442): the storefront origin, same-origin, the Market and an address signed under a
// storefront key; answers mapped to invalid, throttled or failed only.

const SECRET = Buffer.alloc(32, 7);
const ENV = {
  API_BASE_URL: 'http://localhost:3000',
  STOREFRONT_HOSTS: 'http://storefront.localhost:3003=ZZ, https://shop.example.au=AU',
  SELLER_SIGN_IN_URLS:
    'ZZ=http://seller.localhost:3001/sign-in,AU=https://seller.example.au/sign-in',
  BFF_CLIENT_ADDRESS_KEY_ID: 'storefront',
  BFF_CLIENT_ADDRESS_SECRET: SECRET.toString('base64'),
};
const config = parseStorefrontApiConfig(ENV) as StorefrontApiConfig;
const ZZ = config.hosts[0]!;
const target = {
  apiBaseUrl: config.apiBaseUrl,
  clientAddressKey: config.clientAddressKey!,
  host: ZZ,
};
const ADDRESS = '203.0.113.9';
const incoming = new Headers({ 'x-mp-client-address': ADDRESS, 'x-client-address': 'forged' });
const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('seller sign-in pages', () => {
  it('reads one https page per Market, on the seller host', () => {
    expect(parseSellerSignInUrls(ENV.SELLER_SIGN_IN_URLS, config.hosts)).toEqual({
      ZZ: 'http://seller.localhost:3001/sign-in',
      AU: 'https://seller.example.au/sign-in',
    });
    expect(parseSellerSignInUrls('', config.hosts)).toEqual({});
  });

  it.each([
    ['AU=http://seller.example.au/sign-in', 'must use https'],
    ['AU=javascript:alert(1)', 'must use https'],
    ['AU=https://user:pw@seller.example.au/sign-in', 'must use https'],
    ['AU=https://shop.example.au/sign-in', "seller panel's host"],
    ['au=https://seller.example.au/sign-in', 'Market code'],
    ['https://seller.example.au/sign-in', 'not MARKET=url'],
    ['AU=https://seller.example.au/a,AU=https://seller.example.au/b', 'twice'],
    ['NZ=https://seller.example.nz/sign-in', "no sign-in page for Market 'AU'"],
  ])('refuses %j', (raw, message) => {
    expect(() => parseSellerSignInUrls(raw, [config.hosts[1]!])).toThrow(message);
  });
});

describe('seller sign-up headers', () => {
  it('sends the storefront origin, same-origin, the Market and a storefront-signed address', () => {
    const headers = signUpHeaders({ ...target, incoming, now: () => NOW });
    expect(headers.get('origin')).toBe('http://storefront.localhost:3003');
    expect(headers.get('sec-fetch-site')).toBe('same-origin');
    expect(headers.get('x-market-id')).toBe('ZZ');
    expect(headers.get('content-type')).toBe('application/json');
    const seconds = NOW / 1000;
    const signature = createHmac('sha256', SECRET)
      .update(`v1\nstorefront\n${seconds}\n${ADDRESS}\nZZ`)
      .digest('base64url');
    // The address server.mjs set; the browser's own header is never relayed.
    expect(headers.get('x-client-address')).toBe(
      `v1;k=storefront;t=${seconds};a=${ADDRESS};s=${signature}`,
    );
    expect([...headers.keys()].sort()).toEqual([
      'accept',
      'content-type',
      'origin',
      'sec-fetch-site',
      'x-client-address',
      'x-market-id',
    ]);
  });
});

describe('seller sign-up answers', () => {
  const password = { typed: 'x'.repeat(20), maxLength: 128 };

  it('maps 202 to accepted and 429 to throttled with the wait', () => {
    expect(mapSignUpAnswer('sign-up', 202, null, null)).toEqual({ kind: 'accepted' });
    expect(mapSignUpAnswer('verification-email', 202, null, null)).toEqual({ kind: 'accepted' });
    const throttled = { code: 'request.throttled', details: { retryAfterSeconds: 42 } };
    expect(mapSignUpAnswer('sign-up', 429, throttled, '50')).toEqual({
      kind: 'throttled',
      retryAfterSeconds: 42,
    });
    expect(mapSignUpAnswer('verification-email', 429, null, '50')).toEqual({
      kind: 'throttled',
      retryAfterSeconds: 50,
    });
    expect(mapSignUpAnswer('sign-up', 429, null, null)).toEqual({
      kind: 'throttled',
      retryAfterSeconds: 60,
    });
    expect(mapSignUpAnswer('sign-up', 429, null, '999999')).toEqual({
      kind: 'throttled',
      retryAfterSeconds: 3600,
    });
  });

  it('maps the fields the form can show to invalid', () => {
    const body = {
      code: 'validation.failed',
      details: {
        fields: [
          { path: 'displayName', code: 'characters' },
          { path: 'email', code: 'format' },
        ],
      },
    };
    expect(mapSignUpAnswer('sign-up', 400, body, null)).toEqual({
      kind: 'invalid',
      fields: { name: 'name-characters', email: 'email-format' },
    });
    const rejected = (rule: string) => ({ code: 'password.rejected', details: { rule } });
    expect(mapSignUpAnswer('sign-up', 400, rejected('common'), null, password)).toEqual({
      kind: 'invalid',
      fields: { password: 'password-common' },
    });
    expect(mapSignUpAnswer('sign-up', 400, rejected('contains-identity'), null, password)).toEqual({
      kind: 'invalid',
      fields: { password: 'password-identity' },
    });
    expect(mapSignUpAnswer('sign-up', 400, rejected('length'), null, password)).toEqual({
      kind: 'invalid',
      fields: { password: 'password-short' },
    });
    expect(
      mapSignUpAnswer('sign-up', 400, rejected('length'), null, {
        typed: 'x'.repeat(129),
        maxLength: 128,
      }),
    ).toEqual({ kind: 'invalid', fields: { password: 'password-long' } });
  });

  it.each([
    [400, { code: 'validation.failed', details: { fields: [] } }],
    [
      400,
      {
        code: 'validation.failed',
        details: { fields: [{ path: 'extra', code: 'unknown-field' }] },
      },
    ],
    [400, { code: 'validation.failed', details: { fields: [{ path: 'email', code: 'type' }] } }],
    [400, { code: 'password.rejected', details: { rule: 'new-rule' } }],
    [400, { code: 'something.else' }],
    [403, { code: 'request.csrf' }],
    [401, { code: 'session.invalid' }],
    [415, { code: 'request.body-unsupported' }],
    [503, { code: 'request.busy', details: { retryAfterSeconds: 5 } }],
    [503, { code: 'access.unavailable' }],
    [500, null],
    [302, null],
  ])('maps %i %j to failed', (status, body) => {
    expect(mapSignUpAnswer('sign-up', status, body, null, password)).toEqual({ kind: 'failed' });
  });

  it('never answers invalid to "send it again"', () => {
    const body = {
      code: 'validation.failed',
      details: { fields: [{ path: 'email', code: 'format' }] },
    };
    expect(mapSignUpAnswer('verification-email', 400, body, null)).toEqual({ kind: 'failed' });
  });
});

describe('seller sign-up calls', () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('posts the body to the route and maps the answer', async () => {
    const send = vi.fn<typeof fetch>(() =>
      Promise.resolve(json(202, { code: 'sign-up.accepted' })),
    );
    const log = vi.fn();
    const body = { displayName: 'Maryam', email: 'maryam@example.com', password: 'x'.repeat(20) };
    await expect(
      callSellerSignUp({ ...target, incoming, fetch: send, log }, 'sign-up', body),
    ).resolves.toEqual({ kind: 'accepted' });
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/identity/seller/sign-up');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs a failure with codes and ids only, never the address or the password', async () => {
    const send = vi.fn(() =>
      Promise.resolve(
        json(403, { statusCode: 403, code: 'request.csrf' }, { 'x-correlation-id': 'c-1' }),
      ),
    );
    const log = vi.fn();
    const body = { email: 'maryam@example.com' };
    await expect(
      callSellerSignUp({ ...target, incoming, fetch: send, log }, 'verification-email', body),
    ).resolves.toEqual({ kind: 'failed' });
    expect(log).toHaveBeenCalledWith({
      msg: 'storefront.seller-sign-up.failed',
      route: 'verification-email',
      status: 403,
      code: 'request.csrf',
      marketId: 'ZZ',
      correlationId: 'c-1',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('maryam');
  });

  it('fails when the API cannot be reached or the request skipped server.mjs', async () => {
    const log = vi.fn();
    const down = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    await expect(
      callSellerSignUp({ ...target, incoming, fetch: down, log }, 'sign-up', {}),
    ).resolves.toEqual({ kind: 'failed' });
    const send = vi.fn(() => Promise.resolve(json(202, {})));
    await expect(
      callSellerSignUp({ ...target, incoming: new Headers(), fetch: send, log }, 'sign-up', {}),
    ).resolves.toEqual({ kind: 'failed' });
    expect(send).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([line]) => (line as { msg: string }).msg)).toEqual([
      'storefront.seller-sign-up.unreachable',
      'storefront.seller-sign-up.unreachable',
    ]);
  });
});

describe('sell page wired through the BFF', () => {
  async function connected(host: string, env: Record<string, string> = {}) {
    for (const [name, value] of Object.entries({ ...ENV, ...env })) vi.stubEnv(name, value);
    vi.doMock('next/headers', () => ({
      headers: () => Promise.resolve(new Headers({ host, 'x-mp-client-address': ADDRESS })),
    }));
    const send = vi.fn((url: string, init: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    vi.stubGlobal('fetch', send);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const actions = await import('../src/sell/actions.ts');
    const source = await import('../src/storefront/source.ts');
    return { ...actions, ...source, send };
  }

  it('signs up and resends through the API for a listed host', async () => {
    const { signUpSeller, resendSellerEmail, loadSellerSignUp, send } = await connected(
      'storefront.localhost:3003',
    );
    const form = {
      name: ' Maryam Rahimi ',
      email: ' maryam@example.com ',
      password: 'x'.repeat(20),
    };
    await expect(signUpSeller(form)).resolves.toEqual({ kind: 'accepted' });
    await expect(resendSellerEmail('maryam@example.com')).resolves.toEqual({ kind: 'accepted' });
    expect(send.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3000/identity/seller/sign-up',
      'http://localhost:3000/identity/seller/verification-email',
    ]);
    expect(JSON.parse(send.mock.calls[0]![1].body as string)).toEqual({
      displayName: 'Maryam Rahimi',
      email: 'maryam@example.com',
      password: 'x'.repeat(20),
    });
    expect((await loadSellerSignUp()).sellerSignInUrl).toBe('http://seller.localhost:3001/sign-in');
  });

  it('fails without a call for a host that is not listed', async () => {
    const { signUpSeller, send } = await connected('evil.localhost:3003');
    await expect(
      signUpSeller({ name: 'Maryam', email: 'maryam@example.com', password: 'x'.repeat(20) }),
    ).resolves.toEqual({ kind: 'failed' });
    expect(send).not.toHaveBeenCalled();
  });

  it('fails without a call when the storefront has no signing key', async () => {
    const { signUpSeller, send } = await connected('storefront.localhost:3003', {
      // Allowed only while every host is *.localhost (the base's start-up tripwire).
      STOREFRONT_HOSTS: 'http://storefront.localhost:3003=ZZ',
      SELLER_SIGN_IN_URLS: 'ZZ=http://seller.localhost:3001/sign-in',
      BFF_CLIENT_ADDRESS_KEY_ID: '',
      BFF_CLIENT_ADDRESS_SECRET: '',
    });
    await expect(
      signUpSeller({ name: 'Maryam', email: 'maryam@example.com', password: 'x'.repeat(20) }),
    ).resolves.toEqual({ kind: 'failed' });
    expect(send).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ msg: 'storefront.seller-sign-up.off', route: 'sign-up', reason: 'no-key' }),
    );
  });
});
