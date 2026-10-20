import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import type { AppConfig } from '../../../../platform/config/app-config';
import type { MarketRegistry } from '../../../../platform/market-config/market-registry';
import {
  SIGN_IN_PROVIDERS,
  type ProviderExchangeFailure,
  type ProviderIdentity,
  type SignInProviderFlow,
  type SignInProviderName,
  type SignInProviders,
} from '../../application/ports/sign-in-providers';

/** The endpoints and issuers of an OpenID Connect provider; fixed per provider, not config. */
export interface OidcProviderDescriptor {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  /** Every `iss` the provider signs with. */
  readonly issuers: readonly string[];
}

/** Google's OpenID Connect endpoints (https://accounts.google.com/.well-known/openid-configuration). */
export const GOOGLE_OIDC: OidcProviderDescriptor = Object.freeze({
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: Object.freeze(['https://accounts.google.com', 'accounts.google.com']),
});

const DESCRIPTORS: Readonly<Record<SignInProviderName, OidcProviderDescriptor>> = Object.freeze({
  google: GOOGLE_OIDC,
});

/** The client credentials of one provider. */
export interface OidcClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The subset of `fetch` this adapter uses, so tests pass a fake. */
export type FetchLike = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

const REQUEST_TIMEOUT_MS = 5000;
/** The largest response read from a provider. */
const MAX_RESPONSE_CHARS = 100_000;
/** Allowed clock difference for `exp` and `iat`. */
const CLOCK_SKEW_SECONDS = 60;
/** How long fetched signing keys are used before they are fetched again. */
const KEYS_TTL_MS = 60 * 60 * 1000;
/** An unknown `kid` fetches the keys again at most this often (key rotation). */
const KEYS_REFETCH_MS = 60 * 1000;

interface KeySet {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly fetchedAt: number;
}

const decodeJson = (part: string): unknown => {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * {@link SignInProviders} over OpenID Connect's authorisation-code flow with PKCE (S256), for
 * every provider in {@link DESCRIPTORS}. A provider is configured for a Market when the server
 * holds its client (`AppConfig`) and the Market names its redirect URI
 * (`identity.socialSignIn.<provider>.redirectUri`).
 *
 * The ID token comes straight from the token endpoint over TLS, and is still verified in full:
 * RS256 signature by a key of the provider's published set (fetched, cached for an hour, fetched
 * again for an unknown `kid` at most once a minute), `iss`, `aud` (and `azp` when there are
 * several audiences), `exp` and `iat` within a minute of the Clock, and the flow's `nonce`. The
 * client secret, the code, the tokens and the person's email or subject are never logged.
 */
export class OidcSignInProviders implements SignInProviders {
  readonly #logger = new Logger('OidcSignInProviders');
  readonly #keySets = new Map<SignInProviderName, KeySet>();
  readonly #clients: Readonly<Partial<Record<SignInProviderName, OidcClient>>>;

  constructor(
    private readonly markets: MarketRegistry,
    config: Pick<AppConfig, 'googleSignIn'>,
    private readonly clock: Clock,
    private readonly fetchImpl: FetchLike = (url, init) =>
      fetch(url, { ...init, redirect: 'error' }),
  ) {
    this.#clients = Object.freeze(
      config.googleSignIn === null ? {} : { google: config.googleSignIn },
    );
  }

  configured(market: MarketContext): readonly SignInProviderName[] {
    return SIGN_IN_PROVIDERS.filter((provider) => this.#settings(market, provider) !== null);
  }

  authorizationUrl(
    market: MarketContext,
    provider: SignInProviderName,
    flow: SignInProviderFlow,
  ): string | null {
    const settings = this.#settings(market, provider);
    if (settings === null) return null;
    const url = new URL(DESCRIPTORS[provider].authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: settings.client.clientId,
      redirect_uri: settings.redirectUri,
      scope: 'openid email',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: flow.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  async exchange(
    market: MarketContext,
    provider: SignInProviderName,
    code: string,
    flow: SignInProviderFlow,
  ): Promise<Result<ProviderIdentity, ProviderExchangeFailure>> {
    const settings = this.#settings(market, provider);
    if (settings === null) return err('provider.unavailable');
    const descriptor = DESCRIPTORS[provider];
    const answer = await this.#request(market, provider, descriptor.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: settings.redirectUri,
        client_id: settings.client.clientId,
        client_secret: settings.client.clientSecret,
        code_verifier: flow.codeVerifier,
      }).toString(),
    });
    if (!answer.ok) return err(answer.error);
    // 4xx: the provider refused the code (used, expired, another verifier); 5xx: unavailable.
    if (answer.value.status >= 500) return err('provider.unavailable');
    const body = answer.value.json;
    if (answer.value.status !== 200 || !isRecord(body) || typeof body.id_token !== 'string') {
      return err('provider.rejected');
    }
    return this.#verifyIdToken(market, provider, body.id_token, settings.client.clientId, flow);
  }

  async #verifyIdToken(
    market: MarketContext,
    provider: SignInProviderName,
    token: string,
    clientId: string,
    flow: SignInProviderFlow,
  ): Promise<Result<ProviderIdentity, ProviderExchangeFailure>> {
    const rejected = (reason: string): Result<never, ProviderExchangeFailure> => {
      this.#logger.warn({
        msg: 'identity.id-token.rejected',
        provider,
        reason,
        marketId: market.marketId,
      });
      return err('provider.rejected');
    };
    const parts = token.split('.');
    if (parts.length !== 3) return rejected('format');
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeJson(headerPart);
    const claims = decodeJson(payloadPart);
    if (!isRecord(header) || !isRecord(claims)) return rejected('format');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return rejected('alg');
    const key = await this.#key(market, provider, header.kid);
    if (key === 'unavailable') return err('provider.unavailable');
    if (key === null) return rejected('kid');
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`, 'ascii'),
      key,
      Buffer.from(signaturePart, 'base64url'),
    );
    if (!signed) return rejected('signature');

    const now = this.clock.now().epochMilliseconds / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (typeof claims.iss !== 'string' || !DESCRIPTORS[provider].issuers.includes(claims.iss)) {
      return rejected('iss');
    }
    if (!audiences.includes(clientId)) return rejected('aud');
    if (audiences.length > 1 && claims.azp !== clientId) return rejected('azp');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now)
      return rejected('exp');
    if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > now)
      return rejected('iat');
    if (claims.nonce !== flow.nonce) return rejected('nonce');
    if (typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) {
      return rejected('sub');
    }
    if (typeof claims.email !== 'string') return rejected('email');
    return ok({
      subject: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    });
  }

  /** The provider's signing key by `kid`; null when the set has none; 'unavailable' when unreachable. */
  async #key(
    market: MarketContext,
    provider: SignInProviderName,
    kid: string,
  ): Promise<KeyObject | null | 'unavailable'> {
    const nowMs = this.clock.now().epochMilliseconds;
    const cached = this.#keySets.get(provider);
    const fresh = cached !== undefined && nowMs - cached.fetchedAt < KEYS_TTL_MS;
    if (fresh && cached.keys.has(kid)) return cached.keys.get(kid)!;
    if (fresh && nowMs - cached.fetchedAt < KEYS_REFETCH_MS) return null;
    const answer = await this.#request(market, provider, DESCRIPTORS[provider].jwksUri, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!answer.ok || answer.value.status !== 200) return 'unavailable';
    const body = answer.value.json;
    if (!isRecord(body) || !Array.isArray(body.keys)) return 'unavailable';
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys as unknown[]) {
      if (!isRecord(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      if (jwk.use !== undefined && jwk.use !== 'sig') continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // A malformed key is skipped; the others still verify.
      }
    }
    this.#keySets.set(provider, { keys, fetchedAt: nowMs });
    return keys.get(kid) ?? null;
  }

  async #request(
    market: MarketContext,
    provider: SignInProviderName,
    url: string,
    init: Parameters<FetchLike>[1],
  ): Promise<Result<{ readonly status: number; readonly json: unknown }, 'provider.unavailable'>> {
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARS) throw new Error('response too large');
      let json: unknown = null;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
      return ok({ status: response.status, json });
    } catch {
      this.#logger.warn({
        msg: 'identity.sign-in-provider.unavailable',
        provider,
        marketId: market.marketId,
      });
      return err('provider.unavailable');
    }
  }

  #settings(
    market: MarketContext,
    provider: SignInProviderName,
  ): { readonly client: OidcClient; readonly redirectUri: string } | null {
    const client = this.#clients[provider];
    if (client === undefined) return null;
    const redirectUri = this.markets.get(market.marketId).identity.socialSignIn?.[provider]
      ?.redirectUri;
    return redirectUri === undefined ? null : { client, redirectUri };
  }
}
