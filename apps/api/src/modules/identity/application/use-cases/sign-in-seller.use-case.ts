import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseEmailAddress } from '../../domain/email-address';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import { secondFactorStepPolicy } from '../second-factor/admin-policy';
import { SellerSecondStep, type SellerSecondStepOutcome } from '../sign-in/seller-second-step';
import {
  SignInFlow,
  type SellerSignInDependencies,
  type SignedIn,
  type SignInClient,
  type SignInDependencies,
  type SignInRefusal,
} from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';
import { MAX_PASSWORD_BYTES } from './sign-in-customer.use-case';

export type { SignedIn, SignInClient } from '../sign-in/sign-in-flow';

export interface SignInSellerInput {
  readonly email: string;
  readonly password: string;
  /** "Keep me signed in" (identity design 6.1): opt-in, seller side only. */
  readonly keepSignedIn: boolean;
  readonly client: SignInClient;
}

/** A session, or (the account has an active second factor) the ask for a code: no session yet. */
export type SignInSellerOutput = SignedIn | SellerSecondStepOutcome;

export type SignInSellerFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | Exclude<SignInRefusal, { readonly code: 'link.rejected' }>;

export interface SignInSellerDependencies extends SignInDependencies, SellerSignInDependencies {
  readonly factors: SecondFactorRepository;
  readonly challenges: SignInChallengeRepository;
  readonly challengeTokens: OpaqueTokens;
}

/**
 * Seller-side sign-in (identity design 3.3, 6.1, 6.3; SEL-04, AC 4, AC 7; slice 5). Rule
 * `anonymous`. The sequence of 6.3 in {@link SignInFlow} for the seller population, the same as
 * the customer's: the reservation unit, the hash outside any unit (the same work for an unknown
 * address), the closing unit, fail-closed on unreachable counters. After full authentication a
 * seller-side account also needs an active membership (`membership.none`) and a seller that is
 * not suspended (`seller-access.suspended`). A `pending` or `rejected` seller gets a limited
 * session: every use case outside the allow-list of 5.2 answers `access.seller-not-approved`.
 * The answer carries the access state so the panel lands on the status page (`ux.md` F2 step 8).
 *
 * With an active second factor (optional for a seller at launch, owner decision 2026-10-08) a
 * correct password never opens a session: {@link SellerSecondStep} answers a challenge for the
 * code step, {@link CompleteSellerSignIn}, and the account's state is told only after it.
 *
 * The reason of a suspension is told to the owner only, and arrives with the decisions of slice
 * 9; this slice answers the code alone.
 */
export class SignInSeller extends UseCase<
  SignInSellerInput,
  SignInSellerOutput,
  SignInSellerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-in-seller',
    rule: { kind: 'anonymous' },
  };

  readonly #flow: SignInFlow;

  constructor(
    gate: UseCaseGate,
    private readonly deps: SignInSellerDependencies,
  ) {
    super(gate);
    const step = new SellerSecondStep({
      factors: deps.factors,
      challenges: deps.challenges,
      ids: deps.ids,
      challengeTokens: deps.challengeTokens,
    });
    this.#flow = new SignInFlow('seller', deps, null, deps, null, null, step);
  }

  protected async handle(
    context: CallContext,
    input: SignInSellerInput,
  ): Promise<Result<SignInSellerOutput, SignInSellerFailure>> {
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    // Read before any unit; null only matters to an account that has a factor (fail closed).
    const policy = secondFactorStepPolicy(this.deps.policy, context.market);
    const outcome = await this.#flow.runSeller(
      context,
      email.value,
      input.password,
      input.client,
      { keepSignedIn: input.keepSignedIn },
      policy === null
        ? null
        : { challenge: policy.challenge, secondFactorThrottle: policy.secondFactorThrottle },
    );
    if (!outcome.ok && outcome.error.code === 'link.rejected') {
      // The email variant never reads a link.
      throw new Error('SignInSeller: link.rejected without a link');
    }
    return outcome as Result<SignInSellerOutput, SignInSellerFailure>;
  }
}
