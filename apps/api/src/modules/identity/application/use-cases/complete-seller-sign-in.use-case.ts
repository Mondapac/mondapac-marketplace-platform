import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { openSession } from '../../domain/session';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { SessionRepository } from '../ports/session.repository';
import type { SessionTokens } from '../ports/session-secrets';
import { secondFactorStepPolicy } from '../second-factor/admin-policy';
import {
  ChallengeCodeStep,
  type ChallengeStepDependencies,
  type ChallengeStepRefusal,
} from '../second-factor/challenge-code-step';
import { parsePresentedCode, spendCode } from '../second-factor/code-check';
import { resolveSellerGate } from '../sign-in/seller-gate';
import type { SellerSignInDependencies, SignedIn, SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';

export interface CompleteSellerSignInInput {
  /** The challenge's token from the answer of the password step. */
  readonly challengeToken: string;
  /** Six digits from the app, or a recovery code. */
  readonly code: string;
  /** "Keep me signed in" (identity design 6.1), asked again here: the challenge keeps no choice. */
  readonly keepSignedIn: boolean;
  readonly client: SignInClient;
}

export type CompleteSellerSignInOutput = SignedIn;

export type CompleteSellerSignInFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | ChallengeStepRefusal
  | { readonly code: 'account.disabled' }
  | { readonly code: 'membership.none' }
  | { readonly code: 'seller-access.suspended'; readonly reason?: string };

export interface CompleteSellerSignInDependencies
  extends ChallengeStepDependencies, SellerSignInDependencies {
  readonly sessions: SessionRepository;
  readonly tokens: SessionTokens;
  readonly policy: IdentityMarketPolicy;
}

/**
 * The seller's code step (identity design 3.5, 6.3 steps 5 to 7; owner decision 2026-10-08: the
 * second factor is optional for a seller at launch, compulsory before payouts). Rule
 * `anonymous`: the challenge's token is not a credential and the request holds no actor (I1).
 * {@link ChallengeCodeStep} with purpose `second-factor` on the active factor, exactly as the
 * admin's {@link CompleteAdminSignIn}: the challenge and the `second-factor.account` counter are
 * reserved before the code is checked, the code is checked outside any unit, and the closing unit
 * takes the credential lock and compares the challenge's credential time before it spends the
 * code and consumes the challenge.
 *
 * After the factor (6.3 step 6) the account's state is told: `account.disabled`, then the seller
 * side's `membership.none` and `seller-access.suspended` (with the reason for the Seller Owner
 * only) as {@link resolveSellerGate} decides them for a password-only sign-in. Otherwise a seller
 * session opens with the Market's lifetimes ("keep me signed in" as at sign-in) and the sign-in
 * record names it.
 */
export class CompleteSellerSignIn extends UseCase<
  CompleteSellerSignInInput,
  CompleteSellerSignInOutput,
  CompleteSellerSignInFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.complete-seller-sign-in',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('CompleteSellerSignIn');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CompleteSellerSignInDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CompleteSellerSignInInput,
  ): Promise<Result<CompleteSellerSignInOutput, CompleteSellerSignInFailure>> {
    const { market } = context;
    const presented = parsePresentedCode(input.code);
    if (presented === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'code', code: 'format' }] });
    }
    const policy = secondFactorStepPolicy(this.deps.policy, market);
    const kept = input.keepSignedIn
      ? this.deps.policy.sessionLifetime(market, 'seller', true)
      : null;
    const lifetime = kept ?? this.deps.policy.sessionLifetime(market, 'seller');
    if (policy === null || lifetime === null) return err({ code: 'access.unavailable' });
    const issued = this.deps.tokens.issue();
    let suspension: { readonly reason?: string } = {};
    let sellerAccess: SignedIn['sellerAccess'] = null;

    const step: ChallengeCodeStep<{ sessionId: string }> = new ChallengeCodeStep(
      this.deps,
      {
        purpose: 'second-factor',
        population: 'seller',
        factorState: 'active',
        secretOf: (factor) => factor.state.secretCiphertext,
        spend: (factor, check, now) =>
          spendCode(this.deps.factors, market, factor.state.id, check, now),
        succeed: async ({ account, now }) => {
          // 6.3 step 6: told only after the factor.
          if (account.state.status !== 'active') {
            return { kind: 'refused', code: 'account.disabled' };
          }
          const accountId = account.state.id;
          const gate = await resolveSellerGate(this.deps, market, accountId);
          if (gate.kind === 'refused') {
            suspension = gate.reason === undefined ? {} : { reason: gate.reason };
            return { kind: 'refused', code: gate.code };
          }
          sellerAccess = gate.seller.state.state;
          const session = openSession({
            id: this.deps.ids.next<'Session'>(),
            marketId: market.marketId,
            accountId,
            population: 'seller',
            sellerId: gate.seller.state.sellerId,
            transport: 'cookie',
            lifetime,
            now,
          });
          await this.deps.sessions.add(market, session, issued.tokenHash);
          await step.record(context, input.client, accountId, 'signed-in', now, session.id);
          return { kind: 'done', value: { sessionId: session.id } };
        },
      },
      this.#logger,
    );
    const outcome = await step.run(context, input.challengeToken, presented, input.client, policy);
    if (!outcome.ok) {
      this.log('identity.seller-sign-in.refused', context, outcome.error.code);
      const failure = outcome.error as CompleteSellerSignInFailure;
      return err(
        failure.code === 'seller-access.suspended' ? { ...failure, ...suspension } : failure,
      );
    }
    this.log('identity.seller-sign-in.signed-in', context, 'signed-in');
    return ok({
      code: 'signed-in',
      token: issued.token,
      absoluteLifetimeSeconds: lifetime.absoluteLifetimeSeconds,
      persistent: kept !== null,
      sellerAccess,
    });
  }

  /** Codes only: never the token, the code or the address (P 12.3). */
  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
