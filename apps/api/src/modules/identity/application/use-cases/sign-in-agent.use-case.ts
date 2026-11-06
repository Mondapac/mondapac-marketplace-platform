import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseEmailAddress } from '../../domain/email-address';
import { MAX_PASSWORD_BYTES } from '../../domain/password-policy';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { secondFactorStepPolicy } from '../second-factor/admin-policy';
import { AdminSecondStep, type AdminSecondStepOutcome } from '../sign-in/admin-second-step';
import {
  SignInFlow,
  type SignInClient,
  type SignInDependencies,
  type SignInRefusal,
} from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';

export interface SignInAgentInput {
  readonly email: string;
  readonly password: string;
  readonly client: SignInClient;
}

export type SignInAgentOutput = AdminSecondStepOutcome;

export type SignInAgentFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | Exclude<
      SignInRefusal,
      { readonly code: 'link.rejected' | 'membership.none' | 'seller-access.suspended' }
    >;

export interface SignInAgentDependencies extends SignInDependencies {
  readonly factors: SecondFactorRepository;
  readonly challenges: SignInChallengeRepository;
  readonly links: OneTimeLinkRepository;
  readonly outbox: OutboxWriter;
  readonly challengeTokens: OpaqueTokens;
}

/**
 * The agent's password step (ADR-0045 decision 4). Rule `anonymous`. The same sequence as the
 * admin's (`SignInFlow.runAdmin` for the agent population: the same reservation, hash and closing
 * units, the same work for an unknown address), ending at a challenge: an agent has no state in
 * which a password alone opens a session, and an agent without an active factor (which cannot be
 * reached through acceptance) gets the same challenge that no code can pass and is mailed nothing.
 */
export class SignInAgent extends UseCase<SignInAgentInput, SignInAgentOutput, SignInAgentFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-in-agent',
    rule: { kind: 'anonymous' },
  };

  readonly #flow: SignInFlow;

  constructor(
    gate: UseCaseGate,
    private readonly deps: SignInAgentDependencies,
  ) {
    super(gate);
    const step = new AdminSecondStep({
      factors: deps.factors,
      challenges: deps.challenges,
      links: deps.links,
      throttles: deps.throttles,
      keys: deps.keys,
      outbox: deps.outbox,
      policy: deps.policy,
      ids: deps.ids,
      challengeTokens: deps.challengeTokens,
    });
    this.#flow = new SignInFlow('agent', deps, null, null, null, step);
  }

  protected async handle(
    context: CallContext,
    input: SignInAgentInput,
  ): Promise<Result<SignInAgentOutput, SignInAgentFailure>> {
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const policy = secondFactorStepPolicy(this.deps.policy, context.market);
    if (policy === null) return err({ code: 'access.unavailable' });
    const outcome = await this.#flow.runAdmin(context, email.value, input.password, input.client, {
      challenge: policy.challenge,
      secondFactorThrottle: policy.secondFactorThrottle,
    });
    if (!outcome.ok) {
      const code = outcome.error.code;
      if (
        code === 'link.rejected' ||
        code === 'membership.none' ||
        code === 'seller-access.suspended'
      ) {
        throw new Error(`SignInAgent: ${code} for an agent`);
      }
    }
    return outcome as Result<SignInAgentOutput, SignInAgentFailure>;
  }
}
