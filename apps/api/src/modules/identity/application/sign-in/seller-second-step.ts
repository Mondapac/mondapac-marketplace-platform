import type { CallContext, IdGenerator, Temporal } from '@mondapac/shared-kernel';
import type { Account } from '../../domain/account';
import { issueChallenge, type ChallengePolicy } from '../../domain/sign-in-challenge';
import type { ThrottleRule } from '../../domain/throttle';
import type { IssuedLinkToken } from '../ports/link-secrets';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import { lockedFor } from '../second-factor/code-check';

/** What the seller sign-in needs on top of the password sequence (identity design 6.3 step 5). */
export interface SellerSecondStepDependencies {
  readonly factors: SecondFactorRepository;
  readonly challenges: SignInChallengeRepository;
  readonly ids: IdGenerator;
  readonly challengeTokens: OpaqueTokens;
}

/** The policy values the step needs; null while the Market configures none (fail closed). */
export interface SellerSecondStepPolicy {
  readonly challenge: ChallengePolicy;
  readonly secondFactorThrottle: ThrottleRule;
}

/** Where a seller's correct password leads when the account has an active factor. */
export type SellerSecondStepOutcome =
  | {
      readonly code: 'second-factor-required';
      /** The challenge's token: posted back with the code; never a credential (I1). */
      readonly challengeToken: string;
      readonly expiresAt: Temporal.Instant;
    }
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number };

/**
 * Step 5 of the sign-in sequence for a seller-side account (identity design 6.3, 3.6; owner
 * decision of 2026-10-08: the second step is optional for a seller at launch). Run inside the
 * closing unit after a correct password and a verified email:
 *
 * - no active factor: `null`, and the sequence goes on to step 6 and a session as before;
 * - an active factor that is not locked: a `SignInChallenge` (purpose `second-factor`) bound to
 *   the credential's `changedAt` (HF11) is stored with the hash of a new token, and the answer
 *   asks for a code;
 * - an active factor locked by HF2: `second-factor.locked` with the rest of the block;
 * - an active factor while the Market has no challenge policy: `access.unavailable`; a password
 *   alone never opens a session for an account that has a factor.
 *
 * The account's state, its membership and its seller's access are told only after the code
 * (6.3 step 6), in {@link CompleteSellerSignIn}.
 */
export class SellerSecondStep {
  constructor(private readonly deps: SellerSecondStepDependencies) {}

  /** A challenge token, minted before the closing unit like a session token (6.3). */
  issueToken(): IssuedLinkToken {
    return this.deps.challengeTokens.issue();
  }

  async decide(
    context: CallContext,
    account: Account,
    policy: SellerSecondStepPolicy | null,
    challengeToken: IssuedLinkToken,
    now: Temporal.Instant,
  ): Promise<SellerSecondStepOutcome | { readonly code: 'access.unavailable' } | null> {
    const { market } = context;
    const accountId = account.state.id;
    const factor = await this.deps.factors.findByAccount(market, accountId);
    if (factor === null || !factor.isActive) return null;
    if (policy === null) return { code: 'access.unavailable' };
    const wait = lockedFor(factor.state.lockedAt, policy.secondFactorThrottle, now);
    if (wait !== null) return { code: 'second-factor.locked', retryAfterSeconds: wait };
    const challenge = issueChallenge({
      id: this.deps.ids.next<'SignInChallenge'>(),
      marketId: market.marketId,
      accountId,
      purpose: 'second-factor',
      credentialChangedAt: account.state.credential.changedAt,
      policy: policy.challenge,
      now,
    });
    await this.deps.challenges.add(market, challenge, challengeToken.tokenHash);
    return {
      code: 'second-factor-required',
      challengeToken: challengeToken.token,
      expiresAt: challenge.expiresAt,
    };
  }
}
