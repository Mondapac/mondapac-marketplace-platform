import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SessionRepository } from '../ports/session.repository';

export type SignOutAgentOutput = { readonly code: 'signed-out' };
export type SignOutAgentFailure = { readonly code: 'access.denied' };

export interface SignOutAgentDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
}

/**
 * An agent signs out (ADR-0045): revokes the agent's own session with the reason `sign-out`.
 * Rule `agent-self`: only an active agent passes, and the session revoked is the actor's own.
 */
export class SignOutAgent extends UseCase<
  Record<string, never>,
  SignOutAgentOutput,
  SignOutAgentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-out-agent',
    rule: { kind: 'agent-self' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SignOutAgentDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SignOutAgentOutput, SignOutAgentFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'agent') {
      return err({ code: 'access.denied' });
    }
    await this.deps.unitOfWork.run(market, async () => {
      await this.deps.sessions.revoke(
        market,
        actor.sessionId,
        actor.accountId,
        'sign-out',
        this.deps.clock.now(),
      );
      return ok(undefined);
    });
    return ok({ code: 'signed-out' });
  }
}
