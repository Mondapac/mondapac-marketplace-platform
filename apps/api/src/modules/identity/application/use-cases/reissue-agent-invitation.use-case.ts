import { Logger } from '@nestjs/common';
import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  actingAgentManager,
  issueAgentInvitation,
  revokeAgentInvitation,
  type AgentInvitationDependencies,
} from '../agents/agent-invitations';
import { InvitationAlreadyPendingError } from '../ports/invitation.repository';
import type { IssueAgentInvitationOutput } from './issue-agent-invitation.use-case';

export interface ReissueAgentInvitationInput {
  /** The account id `issueAgentInvitation` returned. */
  readonly accountId: Id<'Account'>;
}

export type ReissueAgentInvitationFailure =
  /** The agent has no pending invitation (accepted, revoked, or purged): nothing to reissue. */
  | { readonly code: 'invitation.not-found' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'invitation.already-pending' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

/**
 * Reissues the invitation of an agent who has not accepted yet (ADR-0045 decision 2): a lost
 * handover code or link means revoke and issue again, never a retrieval. In one unit the pending
 * invitation of `accountId` is revoked (its code is void) and a new one is issued for the same
 * address, name and reserved account id, with a new handover code shown once and a new link mail.
 * Rule `own-resources` (an active admin), `agents.manage` re-checked in the unit.
 */
export class ReissueAgentInvitation extends UseCase<
  ReissueAgentInvitationInput,
  IssueAgentInvitationOutput,
  ReissueAgentInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.reissue-agent-invitation',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ReissueAgentInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AgentInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReissueAgentInvitationInput,
  ): Promise<Result<IssueAgentInvitationOutput, ReissueAgentInvitationFailure>> {
    const { market } = context;
    const lifetimeMinutes = this.deps.policy.invitationLifetimeMinutes(market, 'agent');
    if (lifetimeMinutes === null) return err({ code: 'access.unavailable' });
    let result: Result<IssueAgentInvitationOutput, ReissueAgentInvitationFailure>;
    try {
      result = await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<IssueAgentInvitationOutput, ReissueAgentInvitationFailure>> => {
          if (!(await actingAgentManager(this.deps, context))) {
            return err({ code: 'access.denied' });
          }
          const pending = await this.deps.invitations.findPendingAgentByAccountId(
            market,
            input.accountId,
          );
          const email = pending?.state.email;
          const displayName = pending?.state.displayName;
          if (pending === null || email == null || displayName == null) {
            return err({ code: 'invitation.not-found' });
          }
          if (!(await revokeAgentInvitation(this.deps, context, pending))) {
            return err({ code: 'invitation.not-found' });
          }
          const issued = await issueAgentInvitation(this.deps, context, {
            email,
            displayName,
            lifetimeMinutes,
            agentAccountId: input.accountId,
          });
          return issued.ok
            ? { ok: true, value: { code: 'invitation.issued', ...issued.value } }
            : issued;
        },
      );
    } catch (error) {
      if (!(error instanceof InvitationAlreadyPendingError)) throw error;
      result = err({ code: 'invitation.already-pending' });
    }
    this.#logger.log({
      msg: 'identity.reissue-agent-invitation',
      outcome: result.ok ? result.value.code : result.error.code,
      ...(result.ok ? { invitationId: result.value.invitationId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
