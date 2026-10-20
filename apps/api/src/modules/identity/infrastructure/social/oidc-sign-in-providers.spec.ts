import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import type { MarketId } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import {
  loadMarketConfigs,
  type MarketConfig,
} from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { HmacFlowSecrets } from './hmac-flow-secrets';
import { GOOGLE_OIDC, OidcSignInProviders, type FetchLike } from './oidc-sign-in-providers';

const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');
const CLIENT = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret-xyz-123',
};
const REDIRECT = 'https://storefront.au.mondapac.test/api/identity/customer/social/google/callback';
const NOW = Temporal.Instant.from('2026-10-19T23:00:00Z');
const clock = { now: () => NOW };
const nowSeconds = NOW.epochMilliseconds / 1000;

/** The test Markets, with Google sign-in configured for AU only. */
function registry(): MarketRegistry {
  const configs = new Map<MarketId, MarketConfig>(
    loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS),
  );
  const au = configs.get(AU.marketId)!;
  configs.set(AU.marketId, {
    ...au,
    identity: { ...au.identity, socialSignIn: { google: { redirectUri: REDIRECT } } },
  });
  return new MarketRegistry(configs);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' }],
};

function idToken(
  claims: Record<string, unknown>,
  key: KeyObject = privateKey,
  kid = 'key-1',
): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = `${part({ alg: 'RS256', kid, typ: 'JWT' })}.${part(claims)}`;
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}

describe('OidcSignInProviders (social sign-in, Google)', () => {
  const secrets = new HmacFlowSecrets();
  const flow = secrets.derive(secrets.issue(), AU, 'google', 'sign-in')!;
  const goodClaims = () => ({
    iss: 'https://accounts.google.com',
    aud: CLIENT.clientId,
    sub: '1234567890',
    email: 'shopper@example.com',
    email_verified: true,
    nonce: flow.nonce,
    iat: nowSeconds - 10,
    exp: nowSeconds + 3600,
  });

  /** A fake provider: the token endpoint answers `token`, the JWKS endpoint `JWKS`. */
  function provider(token: { status: number; body: unknown }) {
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url, ...(init.body === undefined ? {} : { body: init.body }) });
      const answer = url === GOOGLE_OIDC.tokenEndpoint ? token : { status: 200, body: JWKS };
      return Promise.resolve({
        status: answer.status,
        text: () => Promise.resolve(JSON.stringify(answer.body)),
      });
    };
    const providers = new OidcSignInProviders(
      registry(),
      { googleSignIn: CLIENT },
      clock,
      fetchImpl,
    );
    return { providers, calls };
  }

  it('is configured only where the server holds the client and the Market names its redirect URI', () => {
    const configured = new OidcSignInProviders(registry(), { googleSignIn: CLIENT }, clock);
    expect(configured.configured(AU)).toEqual(['google']);
    expect(configured.configured(ZZ)).toEqual([]);
    expect(configured.authorizationUrl(ZZ, 'google', flow)).toBeNull();
    const noClient = new OidcSignInProviders(registry(), { googleSignIn: null }, clock);
    expect(noClient.configured(AU)).toEqual([]);
  });

  it('builds the authorisation URL with the state, the nonce and the S256 challenge', () => {
    const url = new URL(
      new OidcSignInProviders(registry(), { googleSignIn: CLIENT }, clock).authorizationUrl(
        AU,
        'google',
        flow,
      )!,
    );
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_OIDC.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      scope: 'openid email',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: flow.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    expect(url.toString()).not.toContain(CLIENT.clientSecret);
    expect(url.toString()).not.toContain(flow.codeVerifier);
  });

  it('exchanges the code with the PKCE verifier and returns the verified identity', async () => {
    const { providers, calls } = provider({
      status: 200,
      body: { id_token: idToken(goodClaims()) },
    });

    const result = await providers.exchange(AU, 'google', 'the-code', flow);

    expect(result).toEqual({
      ok: true,
      value: { subject: '1234567890', email: 'shopper@example.com', emailVerified: true },
    });
    const form = new URLSearchParams(calls.find((c) => c.url === GOOGLE_OIDC.tokenEndpoint)!.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT,
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      code_verifier: flow.codeVerifier,
    });
  });

  it.each([
    ['another nonce', { nonce: 'replayed' }],
    ['another audience', { aud: 'someone-else' }],
    ['several audiences without azp', { aud: [CLIENT.clientId, 'x'] }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['an expired token', { exp: nowSeconds - 120 }],
    ['a token from the future', { iat: nowSeconds + 600 }],
    ['no subject', { sub: undefined }],
  ])('rejects %s', async (_name, change) => {
    const { providers } = provider({
      status: 200,
      body: { id_token: idToken({ ...goodClaims(), ...change }) },
    });
    expect(await providers.exchange(AU, 'google', 'c', flow)).toEqual({
      ok: false,
      error: 'provider.rejected',
    });
  });

  it('rejects a token signed by another key, or by an unknown key id', async () => {
    const forged = provider({
      status: 200,
      body: { id_token: idToken(goodClaims(), other.privateKey) },
    });
    expect(await forged.providers.exchange(AU, 'google', 'c', flow)).toEqual({
      ok: false,
      error: 'provider.rejected',
    });
    const unknown = provider({
      status: 200,
      body: { id_token: idToken(goodClaims(), privateKey, 'key-9') },
    });
    expect(await unknown.providers.exchange(AU, 'google', 'c', flow)).toEqual({
      ok: false,
      error: 'provider.rejected',
    });
  });

  it('rejects alg none, an HMAC token and several audiences with another azp', async () => {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'none', kid: 'key-1' })}.${part(goodClaims())}.`;
    const hmacHead = `${part({ alg: 'HS256', kid: 'key-1' })}.${part(goodClaims())}`;
    const hmac = `${hmacHead}.${createHmac('sha256', CLIENT.clientSecret).update(hmacHead).digest('base64url')}`;
    const otherAzp = idToken({ ...goodClaims(), aud: [CLIENT.clientId, 'x'], azp: 'x' });
    for (const token of [unsigned, hmac, otherAzp]) {
      const { providers } = provider({ status: 200, body: { id_token: token } });
      expect(await providers.exchange(AU, 'google', 'c', flow)).toEqual({
        ok: false,
        error: 'provider.rejected',
      });
    }
  });

  it('reports an unverified email as such', async () => {
    const { providers } = provider({
      status: 200,
      body: { id_token: idToken({ ...goodClaims(), email_verified: false }) },
    });
    expect(await providers.exchange(AU, 'google', 'c', flow)).toMatchObject({
      ok: true,
      value: { emailVerified: false },
    });
  });

  it('answers rejected for a refused code and unavailable for a provider error or outage', async () => {
    const refused = provider({ status: 400, body: { error: 'invalid_grant' } });
    expect(await refused.providers.exchange(AU, 'google', 'c', flow)).toEqual({
      ok: false,
      error: 'provider.rejected',
    });
    const down = provider({ status: 503, body: {} });
    expect(await down.providers.exchange(AU, 'google', 'c', flow)).toEqual({
      ok: false,
      error: 'provider.unavailable',
    });
    const unreachable = new OidcSignInProviders(registry(), { googleSignIn: CLIENT }, clock, () =>
      Promise.reject(new Error('ECONNRESET')),
    );
    expect(await unreachable.exchange(AU, 'google', 'c', flow)).toEqual({
      ok: false,
      error: 'provider.unavailable',
    });
  });
});

describe('HmacFlowSecrets', () => {
  const secrets = new HmacFlowSecrets();

  it('derives independent values, different per Market, provider and intent', () => {
    const secret = secrets.issue();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const flow = secrets.derive(secret, AU, 'google', 'sign-in')!;
    expect(new Set([flow.state, flow.nonce, flow.codeVerifier]).size).toBe(3);
    expect(flow.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secrets.derive(secret, AU, 'google', 'sign-in')).toEqual(flow);
    expect(secrets.derive(secret, ZZ, 'google', 'sign-in')!.state).not.toBe(flow.state);
    expect(secrets.derive(secret, AU, 'google', 'link')!.state).not.toBe(flow.state);
    expect(secrets.derive(secrets.issue(), AU, 'google', 'sign-in')!.state).not.toBe(flow.state);
  });

  it('refuses a malformed secret and compares the state exactly', () => {
    expect(secrets.derive('short', AU, 'google', 'sign-in')).toBeNull();
    const flow = secrets.derive(secrets.issue(), AU, 'google', 'sign-in')!;
    expect(secrets.stateMatches(flow, flow.state)).toBe(true);
    expect(secrets.stateMatches(flow, `${flow.state}x`)).toBe(false);
    expect(secrets.stateMatches(flow, '')).toBe(false);
  });
});
