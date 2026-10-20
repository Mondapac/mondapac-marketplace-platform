import type { MarketContext, Result } from '@mondapac/shared-kernel';

/** The sign-in providers a customer may use (social sign-in). Others are added here by name. */
export const SIGN_IN_PROVIDERS = ['google'] as const;
export type SignInProviderName = (typeof SIGN_IN_PROVIDERS)[number];

/** What a flow is for: a sign-in (or sign-up), or connecting the provider to the signed-in account. */
export const SIGN_IN_PROVIDER_INTENTS = ['sign-in', 'link'] as const;
export type SignInProviderIntent = (typeof SIGN_IN_PROVIDER_INTENTS)[number];

/**
 * The values of one authorisation-code flow (OAuth 2.0 with PKCE, OpenID Connect), all derived
 * from the flow secret the browser holds in its flow cookie, the Market, the provider and the
 * intent: nothing of a flow is stored on the server.
 */
export interface SignInProviderFlow {
  /** Sent to the provider and compared with the one it returns (CSRF of the redirect). */
  readonly state: string;
  /** Sent to the provider and compared with the ID token's `nonce` (replay). */
  readonly nonce: string;
  /** PKCE: the verifier sent with the code exchange, and its S256 challenge. */
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

/** The flow secrets (the flow cookie's value): random, and the derivation of a flow from one. */
export interface SignInProviderFlowSecrets {
  /** A new flow secret: 32 bytes from the system random source, base64url. */
  issue(): string;
  /** The flow of a presented secret, or null when it does not have a secret's shape. */
  derive(
    secret: string,
    market: MarketContext,
    provider: SignInProviderName,
    intent: SignInProviderIntent,
  ): SignInProviderFlow | null;
  /** Whether a presented state equals the flow's, compared in constant time. */
  stateMatches(flow: SignInProviderFlow, presented: string): boolean;
}

/** Nest token of the {@link SignInProviderFlowSecrets}. */
export const SIGN_IN_PROVIDER_FLOW_SECRETS = Symbol('SIGN_IN_PROVIDER_FLOW_SECRETS');

/** Who the provider says signed in: its stable subject id and the email it vouches for. */
export interface ProviderIdentity {
  /** The provider's stable id of the person (`sub`); never shown, logged or put in an event. */
  readonly subject: string;
  readonly email: string;
  /** Whether the provider verified the email (`email_verified`). */
  readonly emailVerified: boolean;
}

/**
 * Why a code exchange gave no identity: the provider refused the code or the ID token failed a
 * check (`provider.rejected`), or the provider could not be reached (`provider.unavailable`).
 */
export type ProviderExchangeFailure = 'provider.rejected' | 'provider.unavailable';

/**
 * The sign-in providers of a Market. A provider is configured for a Market when the server holds
 * its client credentials (`AppConfig`) and the Market's config names its redirect URI; otherwise
 * every method answers as if it did not exist.
 */
export interface SignInProviders {
  configured(market: MarketContext): readonly SignInProviderName[];
  /** The provider's authorisation URL for the flow, or null when it is not configured. */
  authorizationUrl(
    market: MarketContext,
    provider: SignInProviderName,
    flow: SignInProviderFlow,
  ): string | null;
  /**
   * Exchanges the code (with the PKCE verifier) and verifies the ID token: signature, issuer,
   * audience, expiry and `nonce`.
   */
  exchange(
    market: MarketContext,
    provider: SignInProviderName,
    code: string,
    flow: SignInProviderFlow,
  ): Promise<Result<ProviderIdentity, ProviderExchangeFailure>>;
}

/** Nest token of the {@link SignInProviders}. */
export const SIGN_IN_PROVIDERS_PORT = Symbol('SIGN_IN_PROVIDERS');
