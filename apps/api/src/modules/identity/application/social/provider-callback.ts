import { err, ok } from '@mondapac/shared-kernel';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import { parseEmailAddress, type EmailAddress } from '../../domain/email-address';
import type {
  ProviderExchangeFailure,
  SignInProviderFlowSecrets,
  SignInProviderIntent,
  SignInProviderName,
  SignInProviders,
} from '../ports/sign-in-providers';

/** A provider's answer as it reaches a callback: the code, the state and the browser's secret. */
export interface ProviderCallbackInput {
  readonly provider: SignInProviderName;
  readonly code: string;
  readonly state: string;
  /** The flow cookie's secret. */
  readonly flowSecret: string;
}

/** The longest code and state accepted, so a request cannot post an unbounded value upstream. */
const MAX_CODE_LENGTH = 2048;
const MAX_STATE_LENGTH = 128;

export type ProviderCallbackFailure =
  | { readonly code: 'sign-in-provider.not-configured' }
  /** The flow cookie is missing or malformed, or the state is not this browser's (CSRF). */
  | { readonly code: 'flow.rejected' }
  | { readonly code: ProviderExchangeFailure }
  /** The provider did not verify the email, or the email is not one an account can hold. */
  | { readonly code: 'email.unverified' };

/** The provider's person, with an email it verified, as an account email. */
export interface VerifiedProviderIdentity {
  readonly subject: string;
  readonly email: EmailAddress;
}

/**
 * The checks every provider callback runs before it reads an account (social sign-in): the
 * provider is configured for the Market; the flow secret has its shape and the state is the one
 * derived from it for this Market, provider and intent (compared in constant time), so a
 * callback started in another browser, or for the other intent, is refused before the code is
 * spent; the code is exchanged with the PKCE verifier and the ID token checked (nonce included);
 * the provider verified the email and the email parses as an account email.
 */
export async function verifyProviderCallback(
  market: MarketContext,
  intent: SignInProviderIntent,
  input: ProviderCallbackInput,
  providers: SignInProviders,
  secrets: SignInProviderFlowSecrets,
): Promise<Result<VerifiedProviderIdentity, ProviderCallbackFailure>> {
  if (!providers.configured(market).includes(input.provider)) {
    return err({ code: 'sign-in-provider.not-configured' });
  }
  if (
    input.code.length === 0 ||
    input.code.length > MAX_CODE_LENGTH ||
    input.state.length === 0 ||
    input.state.length > MAX_STATE_LENGTH
  ) {
    return err({ code: 'flow.rejected' });
  }
  const flow = secrets.derive(input.flowSecret, market, input.provider, intent);
  if (flow === null || !secrets.stateMatches(flow, input.state)) {
    return err({ code: 'flow.rejected' });
  }
  const exchanged = await providers.exchange(market, input.provider, input.code, flow);
  if (!exchanged.ok) return err({ code: exchanged.error });
  const { subject, email, emailVerified } = exchanged.value;
  const parsed = parseEmailAddress(email);
  if (!emailVerified || !parsed.ok) return err({ code: 'email.unverified' });
  return ok({ subject, email: parsed.value });
}
