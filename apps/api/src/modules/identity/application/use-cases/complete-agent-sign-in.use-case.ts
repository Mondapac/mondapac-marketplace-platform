import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { AgentSessionOpenedAudit } from '../../domain/audit';
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
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';

export interface CompleteAgentSignInInput {
  /** The challenge's token from the answer of the password step. */
  readonly challengeToken: string;
  /** Six digits from the app, or a recovery code. */
  readonly code: string;
  readonly client: SignInClient;
}

/** A new admin session. The token goes into the cookie only, never a body or a log. */
export interface CompleteAgentSignInOutput {
  readonly code: 'signed-in';
  readonly token: string;
  readonly absoluteLifetimeSeconds: number;
}

export type CompleteAgentSignInFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | ChallengeStepRefusal
  | { readonly code: 'account.disabled' };

export interface CompleteAgentSignInDependencies extends ChallengeStepDependencies {
  readonly sessions: SessionRepository;
  readonly tokens: SessionTokens;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
}

/**
 * The agent's code step (ADR-0045 decision 4). Rule `anonymous`: the challenge's token is not a
 * credential. {@link ChallengeCodeStep} with purpose `second-factor` on the active factor, as for
 * an admin; a session opens only from this proof, with the Market's agent lifetimes (never
 * persistent, never extended), `identity.agent-session.opened` in the same unit and the sign-in
 * record naming the session. A disabled account is `account.disabled`, told only after the factor.
 */
export class CompleteAgentSignIn extends UseCase<
  CompleteAgentSignInInput,
  CompleteAgentSignInOutput,
  CompleteAgentSignInFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.complete-agent-sign-in',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('CompleteAgentSignIn');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CompleteAgentSignInDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CompleteAgentSignInInput,
  ): Promise<Result<CompleteAgentSignInOutput, CompleteAgentSignInFailure>> {
    const { market } = context;
    const presented = parsePresentedCode(input.code);
    if (presented === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'code', code: 'format' }] });
    }
    const policy = secondFactorStepPolicy(this.deps.policy, market);
    const lifetime = this.deps.policy.sessionLifetime(market, 'agent');
    if (policy === null || lifetime === null) return err({ code: 'access.unavailable' });
    const issued = this.deps.tokens.issue();

    const step: ChallengeCodeStep<{ sessionId: string }> = new ChallengeCodeStep(
      this.deps,
      {
        purpose: 'second-factor',
        population: 'agent',
        factorState: 'active',
        secretOf: (factor) => factor.state.secretCiphertext,
        spend: (factor, check, now) =>
          spendCode(this.deps.factors, market, factor.state.id, check, now),
        succeed: async ({ account, now }) => {
          // 6.3 step 6: told only after the factor.
          if (account.state.status !== 'active')
            return { kind: 'refused', code: 'account.disabled' };
          const accountId = account.state.id;
          const session = openSession({
            id: this.deps.ids.next<'Session'>(),
            marketId: market.marketId,
            accountId,
            population: 'agent',
            sellerId: null,
            transport: 'cookie',
            device: input.client.device ?? null,
            lifetime,
            now,
          });
          await this.deps.sessions.add(market, session, issued.tokenHash);
          await this.deps.audit.record(
            context,
            AgentSessionOpenedAudit.entry(accountId, {
              after: { sessionId: session.id, boundSubjectId: accountId },
            }),
          );
          await step.record(context, input.client, accountId, 'signed-in', now, session.id);
          return { kind: 'done', value: { sessionId: session.id } };
        },
      },
      this.#logger,
    );
    const outcome = await step.run(context, input.challengeToken, presented, input.client, policy);
    if (!outcome.ok) {
      this.log('identity.agent-sign-in.refused', context, outcome.error.code);
      return err(outcome.error as CompleteAgentSignInFailure);
    }
    this.log('identity.agent-sign-in.signed-in', context, 'signed-in');
    return ok({
      code: 'signed-in',
      token: issued.token,
      absoluteLifetimeSeconds: lifetime.absoluteLifetimeSeconds,
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
