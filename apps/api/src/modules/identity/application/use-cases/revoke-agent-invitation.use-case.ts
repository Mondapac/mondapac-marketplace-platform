import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  actingAgentManager,
  revokeAgentInvitation,
  type AgentInvitationDependencies,
} from '../agents/agent-invitations';

export interface RevokeAgentInvitationInput {
  readonly invitationId: Id<'Invitation'>;
}

export type RevokeAgentInvitationFailure =
  /** No pending agent invitation with this id in the Market (also an expired-and-purged one). */
  { readonly code: 'invitation.not-found' } | { readonly code: 'access.denied' };

/**
 * Revokes a pending agent invitation (ADR-0045 decision 2: "revoke, reissue"). Rule
 * `own-resources` (an active admin); in one unit the acting admin is re-checked for
 * `agents.agent.manage`, the invitation is read in this Market (an invitation of another kind is
 * `invitation.not-found`, so this never revokes an admin or seller invitation), revoked (its
 * address, name and handover code are cleared) and audited with its event.
 */
export class RevokeAgentInvitation extends UseCase<
  RevokeAgentInvitationInput,
  { readonly code: 'invitation.revoked' },
  RevokeAgentInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.revoke-agent-invitation',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('RevokeAgentInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<
      AgentInvitationDependencies,
      | 'unitOfWork'
      | 'accounts'
      | 'grants'
      | 'effectiveKeys'
      | 'invitations'
      | 'outbox'
      | 'audit'
      | 'clock'
    >,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RevokeAgentInvitationInput,
  ): Promise<Result<{ readonly code: 'invitation.revoked' }, RevokeAgentInvitationFailure>> {
    const { market } = context;
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<
        Result<{ readonly code: 'invitation.revoked' }, RevokeAgentInvitationFailure>
      > => {
        if (!(await actingAgentManager(this.deps, context))) return err({ code: 'access.denied' });
        const invitation = await this.deps.invitations.findById(market, input.invitationId);
        if (invitation === null || invitation.state.kind !== 'agent') {
          return err({ code: 'invitation.not-found' });
        }
        if (!(await revokeAgentInvitation(this.deps, context, invitation))) {
          return err({ code: 'invitation.not-found' });
        }
        return ok({ code: 'invitation.revoked' });
      },
    );
    this.#logger.log({
      msg: 'identity.revoke-agent-invitation',
      outcome: result.ok ? result.value.code : result.error.code,
      invitationId: input.invitationId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
