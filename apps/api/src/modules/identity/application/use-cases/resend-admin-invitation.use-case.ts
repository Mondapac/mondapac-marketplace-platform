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
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleRepository } from '../ports/seller-team.repository';
import {
  grantedRoleOf,
  inviterMayStillGrant,
  protectedKeysOf,
  readActingGrants,
  roleIsInActorsReach,
  type GrantSubject,
} from '../roles/granting';

const RULE_KEYS = [ADMIN_ACCOUNT_INVITE.key];

export interface ResendAdminInvitationInput {
  readonly invitationId: Id<'Invitation'>;
}

export interface ResendAdminInvitationOutput {
  readonly code: 'invitation.reissued';
  readonly invitationId: Id<'Invitation'>;
}

export type ResendAdminInvitationFailure =
  /** No admin invitation with this id in the Market: "not found". */
  | { readonly code: 'invitation.unknown' }
  /**
   * Decided, a first-admin invitation, past its lifetime, its role gone (R12), or its inviter no
   * longer able to issue it: it cannot be sent again.
   */
  | { readonly code: 'invitation.rejected' }
  | { readonly code: 'role.not-grantable' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface ResendAdminInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
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
 * expiry on `identity.invitation-issued.v1`. A pending invitation whose token expired may be
 * sent again, but only before `createdAt` plus the admin lifetime (Mohammad C2 on PR #187); after
 * that the admin invites again, which replaces it.
 *
 * In one unit: the actor, still an active, verified admin holding the rule's key (Mohammad C1;
 * else `access.denied`); an admin invitation of this Market (else `invitation.unknown`). Only an
 * invitation issued by an admin (with an inviter): the first-admin invitation of the operator
 * routine (7.4) is refused at acceptance once the Market has an administrator (HF5), so sending
 * it again answers `invitation.rejected` (Mohammad Q4), as a decided one does. The actor must
 * still be able to grant the role, read in this unit (R1, R11; Hassan I-2), so a re-send never
 * lends a role the actor could not invite with today; and the original inviter must still pass
 * the acceptance's check (Hassan L3), else `invitation.rejected`, since such an invitation could
 * never be accepted. Audit `identity.invitation.reissued`.
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
    const lifetime = this.deps.policy.invitationLifetimeMinutes(market, 'admin');
    if (lifetime === null) return err({ code: 'access.unavailable' });
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<ResendAdminInvitationOutput, ResendAdminInvitationFailure>> => {
        const now = this.deps.clock.now();
        // C1: the actor is still an active admin holding the rule's key, read in this unit.
        const reading = await readActingGrants(this.deps, market, self, [], RULE_KEYS);
        if (reading === null) return err({ code: 'access.denied' });
        const invitation = await this.deps.invitations.findById(market, input.invitationId);
        if (invitation === null || invitation.state.kind !== 'admin') {
          return err({ code: 'invitation.unknown' });
        }
        const inviterId = invitation.state.invitedByAccountId;
        // Mohammad Q4: the first-admin invitation is found (revoke finds it) but never re-sent.
        if (inviterId === null || invitation.state.state !== 'pending') {
          return err({ code: 'invitation.rejected' });
        }
        const role = await this.deps.roles.findById(market, invitation.state.roleId);
        if (role === null || !roleIsInActorsReach(role, self)) {
          return err({ code: 'invitation.rejected' });
        }
        const granted = GrantPolicy.canGrant(
          reading.actor,
          grantedRoleOf(role, this.deps.effectiveKeys),
          protectedKeysOf(this.deps.permissions),
        );
        if (!granted.ok) return err({ code: 'role.not-grantable' });
        // Hassan L3: an invitation its inviter could no longer issue can never be accepted.
        const inviter = await inviterMayStillGrant(this.deps, market, inviterId, role);
        if (!inviter.ok) {
          this.log('identity.resend-admin-invitation.inviter-refused', context, {
            reason: inviter.error,
          });
          return err({ code: 'invitation.rejected' });
        }
        // Mohammad C2: refused at and after createdAt plus the lifetime.
        if (!invitation.reissue(now, lifetime).ok) return err({ code: 'invitation.rejected' });
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
    this.log('identity.resend-admin-invitation', context, {
      outcome: result.ok ? result.value.code : result.error.code,
      invitationId: input.invitationId,
    });
    return result;
  }

  /** Ids and codes only: never the address. */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
