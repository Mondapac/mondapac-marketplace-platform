import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  SignInProviderFlow,
  SignInProviderFlowSecrets,
  SignInProviderIntent,
  SignInProviderName,
} from '../../application/ports/sign-in-providers';

const SECRET_BYTES = 32;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * {@link SignInProviderFlowSecrets}: the flow secret is 32 bytes from the system random source,
 * base64url, kept only in the browser's flow cookie. Each value of the flow is HMAC-SHA-256
 * under that secret of a JSON array naming the value, the Market, the provider and the intent,
 * so the state, the nonce and the PKCE verifier are independent (the state and the nonce leave
 * the server; the verifier cannot be computed from them) and a secret never derives the values
 * of another Market, provider or intent.
 */
export class HmacFlowSecrets implements SignInProviderFlowSecrets {
  issue(): string {
    return randomBytes(SECRET_BYTES).toString('base64url');
  }

  derive(
    secret: string,
    market: MarketContext,
    provider: SignInProviderName,
    intent: SignInProviderIntent,
  ): SignInProviderFlow | null {
    if (!SECRET.test(secret)) return null;
    const key = Buffer.from(secret, 'base64url');
    const value = (name: string): string =>
      createHmac('sha256', key)
        .update(JSON.stringify([name, market.marketId, provider, intent]))
        .digest('base64url');
    const codeVerifier = value('pkce-verifier');
    return {
      state: value('state'),
      nonce: value('nonce'),
      codeVerifier,
      codeChallenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
    };
  }

  stateMatches(flow: SignInProviderFlow, presented: string): boolean {
    const expected = Buffer.from(flow.state, 'utf8');
    const given = Buffer.from(presented, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
