import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { SessionRepository } from '../ports/session.repository';

export interface AgentSessionSummary {
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  readonly timezone: string | null;
  readonly locale: string | null;
  readonly session: { readonly idleTimeoutSeconds: number; readonly absoluteExpiresAt: string };
}

export type DescribeAgentSessionFailure = { readonly code: 'access.denied' };

export interface DescribeAgentSessionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
}

/**
 * The signed-in agent's own account and session (ADR-0045 decision 6). Rule `agent-self`: an
 * agent holds no role, so the summary has no permission keys. Read-only; the account and session
 * are the actor's own, read in this Market.
 */
export class DescribeAgentSession extends UseCase<
  Record<string, never>,
  AgentSessionSummary,
  DescribeAgentSessionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.describe-agent-session',
    rule: { kind: 'agent-self' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DescribeAgentSessionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<AgentSessionSummary, DescribeAgentSessionFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'agent') {
      return err({ code: 'access.denied' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok({
          account: await this.deps.accounts.findById(market, actor.accountId),
          session: await this.deps.sessions.findById(market, actor.sessionId),
        }),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    const { account, session } = read.value;
    if (
      account === null ||
      account.state.population !== 'agent' ||
      session === null ||
      session.accountId !== actor.accountId
    ) {
      return err({ code: 'access.denied' });
    }
    return ok({
      accountId: actor.accountId,
      email: account.state.email.typed,
      displayName: account.state.displayName,
      timezone: account.state.timezone ?? null,
      locale: account.state.locale ?? null,
      session: {
        idleTimeoutSeconds: session.idleTimeoutSeconds,
        absoluteExpiresAt: session.absoluteExpiresAt.toString(),
      },
    });
  }
}
