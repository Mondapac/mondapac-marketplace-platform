import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { TEAM_MEMBER_INVITE } from '../../contracts/permissions';
import { InvitationReissuedAudit, InvitationRevokedAudit } from '../../domain/audit';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { RoleRepository, SellerMembershipRepository } from '../ports/seller-team.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';
import { reserveInvitationMail } from './invitation-mail-budget';
import {
  readActingSellerGrants,
  sellerSubjectOf,
  staffInvitationResendVerdict,
} from './seller-team';

const RULE_KEYS = [TEAM_MEMBER_INVITE.key];

export interface StaffInvitationInput {
  readonly invitationId: Id<'Invitation'>;
  /** The inviter's client: the `mail.origin` key of a re-send (6.8). */
  readonly origin: string;
}

export interface StaffInvitationChanged {
  readonly code: 'invitation.reissued' | 'invitation.revoked';
  readonly invitationId: Id<'Invitation'>;
}

export type StaffInvitationFailure =
  /** No Staff invitation of the actor's seller with this id: "not found" (another seller's too). */
  | { readonly code: 'invitation.unknown' }
  /** Decided, past its lifetime, its role gone, or its inviter could no longer issue it. */
  | { readonly code: 'invitation.rejected' }
  | { readonly code: 'role.not-grantable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface StaffInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly memberships: SellerMembershipRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly invitations: InvitationRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

const logger = new Logger('StaffInvitation');

/**
 * Re-send and revoke of a Staff invitation (identity design 3.4 `pending` → `pending`,
 * `pending` → `revoked`; R12; slice 11), the routine of `identity.resend-staff-invitation` and
 * `identity.revoke-staff-invitation`, both under `identity.team-member.invite` and denied while
 * the seller is not approved. One serializable unit: the actor re-read as the issue reads it
 * (`readActingSellerGrants`), then a Staff invitation **of the actor's own seller** (any other
 * id, kind or seller is `invitation.unknown`, byte-identical to a missing one: R6).
 *
 * A re-send runs `staffInvitationResendVerdict` (the one verdict of the command and of the team
 * list's hint): the role still in reach and grantable by the actor, the inviter still standing,
 * within the lifetime (Mohammad C2); then the mail counters (6.8): used up is `request.throttled`
 * and nothing commits. The old token stops working at once and the mail handler sends a new one.
 * A revoke only narrows access, so it needs no grant check. The address is cleared with the
 * decision (data design 4). Audit `identity.invitation.reissued` or `.revoked` as the actor.
 */
export async function changeStaffInvitation(
  deps: StaffInvitationDependencies,
  context: CallContext,
  input: StaffInvitationInput,
  change: 'resend' | 'revoke',
): Promise<Result<StaffInvitationChanged, StaffInvitationFailure>> {
  const { market } = context;
  const self = sellerSubjectOf(context);
  if (self === null || self.sellerId === null) return err({ code: 'access.denied' });
  const sellerId = self.sellerId;
  const lifetime = deps.policy.invitationLifetimeMinutes(market, 'staff');
  if (change === 'resend' && lifetime === null) return err({ code: 'access.unavailable' });
  const result = await deps.unitOfWork.run(
    market,
    async (): Promise<Result<StaffInvitationChanged, StaffInvitationFailure>> => {
      const now = deps.clock.now();
      const reading = await readActingSellerGrants(deps, market, self, [], RULE_KEYS);
      if (reading === null) return err({ code: 'access.denied' });
      const invitation = await deps.invitations.findById(market, input.invitationId);
      if (
        invitation === null ||
        invitation.state.kind !== 'staff' ||
        invitation.state.sellerId !== sellerId
      ) {
        return err({ code: 'invitation.unknown' });
      }
      const { kind, roleId } = invitation.state;
      if (change === 'resend') {
        const address = invitation.state.email;
        const verdict = await staffInvitationResendVerdict(
          deps,
          market,
          { self, view: reading.actor },
          invitation.state,
          now,
          lifetime!,
        );
        if (!verdict.ok) {
          if (verdict.error.code === 'invitation.rejected' && verdict.error.inviterRefusal) {
            logger.log({
              msg: 'identity.resend-staff-invitation.inviter-refused',
              reason: verdict.error.inviterRefusal,
              marketId: market.marketId,
              correlationId: context.correlationId,
            });
          }
          return err({ code: verdict.error.code });
        }
        if (address === null) return err({ code: 'invitation.rejected' });
        const budget = await reserveInvitationMail(
          deps,
          market,
          'seller',
          address.normalized,
          input.origin,
          now,
        );
        if (!budget.allowed) {
          return err({ code: 'request.throttled', retryAfterSeconds: budget.retryAfterSeconds });
        }
        if (!invitation.reissue(now, lifetime!).ok) return err({ code: 'invitation.rejected' });
      } else if (!invitation.revoke(now).ok) {
        return err({ code: 'invitation.rejected' });
      }
      await deps.invitations.save(market, invitation);
      await deps.outbox.append(context, invitation.pendingEvents);
      const audited = change === 'resend' ? InvitationReissuedAudit : InvitationRevokedAudit;
      await deps.audit.record(
        context,
        audited.entry(invitation.state.id, { after: { kind, roleId } }),
      );
      return ok({
        code: change === 'resend' ? 'invitation.reissued' : 'invitation.revoked',
        invitationId: invitation.state.id,
      });
    },
    { isolation: 'serializable' },
  );
  logger.log({
    msg: `identity.${change}-staff-invitation`,
    outcome: result.ok ? result.value.code : result.error.code,
    invitationId: input.invitationId,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return result;
}
