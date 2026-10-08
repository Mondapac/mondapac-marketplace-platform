import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import { ADMIN_ACCOUNT_INVITE } from '../../contracts/permissions';
import { InvitationReissuedAudit } from '../../domain/audit';
import { GrantPolicy } from '../../domain/grant-policy';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleRepository } from '../ports/seller-team.repository';
import {
  grantedRoleOf,
  protectedKeysOf,
  readGrants,
  roleIsInActorsReach,
  type GrantSubject,
} from '../roles/granting';

export interface ResendAdminInvitationInput {
  readonly invitationId: Id<'Invitation'>;
}

export interface ResendAdminInvitationOutput {
  readonly code: 'invitation.reissued';
  readonly invitationId: Id<'Invitation'>;
}

export type ResendAdminInvitationFailure =
  /** No admin invitation with an inviter, with this id, in the Market: "not found". */
  | { readonly code: 'invitation.unknown' }
  /** Decided (accepted or revoked), or its role is gone (R12): it cannot be sent again. */
  | { readonly code: 'invitation.rejected' }
  | { readonly code: 'role.not-grantable' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface ResendAdminInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly roles: RoleRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly invitations: InvitationRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

/**
 * Sends a pending admin invitation again (identity design 3.4 `pending` → `pending`, flow E2;
 * slice 8b). Rule `permissions [identity.admin-account.invite]` (protected). The earlier token
 * stops working at once (`Invitation.reissue`); the mail handler mints a new one with a new
 * expiry on `identity.invitation-issued.v1`. An expired pending invitation may be sent again.
 *
 * Only an invitation issued by an admin (with an inviter): the first-admin invitation of the
 * operator routine (7.4) is refused at acceptance once the Market has an administrator (HF5),
 * so sending it again is answered `invitation.unknown`, as any other id. The actor must still be
 * able to grant the role, read in this unit (R1, R11; Hassan I-2), so a re-send never lends a
 * role the actor could not invite with today. Audit `identity.invitation.reissued`.
 */
export class ResendAdminInvitation extends UseCase<
  ResendAdminInvitationInput,
  ResendAdminInvitationOutput,
  ResendAdminInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.resend-admin-invitation',
    rule: { kind: 'permissions', allOf: [ADMIN_ACCOUNT_INVITE.key] },
  };

  readonly #logger = new Logger('ResendAdminInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ResendAdminInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ResendAdminInvitationInput,
  ): Promise<Result<ResendAdminInvitationOutput, ResendAdminInvitationFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    if (this.deps.policy.invitationLifetimeMinutes(market, 'admin') === null) {
      return err({ code: 'access.unavailable' });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<ResendAdminInvitationOutput, ResendAdminInvitationFailure>> => {
        const now = this.deps.clock.now();
        const invitation = await this.deps.invitations.findById(market, input.invitationId);
        if (
          invitation === null ||
          invitation.state.kind !== 'admin' ||
          invitation.state.invitedByAccountId === null
        ) {
          return err({ code: 'invitation.unknown' });
        }
        if (invitation.state.state !== 'pending') return err({ code: 'invitation.rejected' });
        const role = await this.deps.roles.findById(market, invitation.state.roleId);
        if (role === null || !roleIsInActorsReach(role, self)) {
          return err({ code: 'invitation.rejected' });
        }
        const reading = await readGrants(
          this.deps.grants,
          this.deps.effectiveKeys,
          market,
          self,
          [],
        );
        if (reading === null) return err({ code: 'access.denied' });
        const granted = GrantPolicy.canGrant(
          reading.actor,
          grantedRoleOf(role, this.deps.effectiveKeys),
          protectedKeysOf(this.deps.permissions),
        );
        if (!granted.ok) return err({ code: 'role.not-grantable' });
        if (!invitation.reissue(now).ok) return err({ code: 'invitation.rejected' });
        await this.deps.invitations.save(market, invitation);
        await this.deps.outbox.append(context, invitation.pendingEvents);
        await this.deps.audit.record(
          context,
          InvitationReissuedAudit.entry(invitation.state.id, {
            after: { kind: 'admin', roleId: role.state.id },
          }),
        );
        return ok({ code: 'invitation.reissued', invitationId: invitation.state.id });
      },
    );
    this.#logger.log({
      msg: 'identity.resend-admin-invitation',
      outcome: result.ok ? result.value.code : result.error.code,
      invitationId: input.invitationId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
