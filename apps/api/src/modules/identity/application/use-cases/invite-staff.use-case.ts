import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import { TEAM_MEMBER_INVITE } from '../../contracts/permissions';
import { InvitationIssuedAudit, InvitationRevokedAudit } from '../../domain/audit';
import { parseEmailAddress } from '../../domain/email-address';
import { Invitation } from '../../domain/invitation';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import {
  InvitationAlreadyPendingError,
  type InvitationRepository,
} from '../ports/invitation.repository';
import type { LinkTargets } from '../ports/link-secrets';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { RoleRepository, SellerMembershipRepository } from '../ports/seller-team.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';
import { roleGrantVerdict, roleIsInActorsReach } from '../roles/granting';
import { reserveInvitationMail } from '../sellers/invitation-mail-budget';
import { readActingSellerGrants, sellerSubjectOf } from '../sellers/seller-team';
import type { FieldProblem } from './register-customer.use-case';

const RULE_KEYS = [TEAM_MEMBER_INVITE.key];

export interface InviteStaffInput {
  /** The invitee's address. Personal data: never logged or audited. */
  readonly email: string;
  readonly roleId: Id<'Role'>;
  /** The inviter's client: the `mail.origin` key of the invitation mail (6.8). */
  readonly origin: string;
}

export interface InviteStaffOutput {
  readonly code: 'invitation.issued';
  readonly invitationId: Id<'Invitation'>;
  /** Whether a stale pending invitation for the same address was revoked first (M7). */
  readonly replaced: boolean;
}

export type InviteStaffFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  /** No seller role of this seller with this id (also another seller's role): "not found". */
  | { readonly code: 'role.unknown' }
  | { readonly code: 'role.not-grantable' }
  | { readonly code: 'invitation.already-pending' }
  /** Active members and pending invitations together have reached the Market's limit. */
  | { readonly code: 'member.limit' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  /** The Market configures no Staff lifetime, member limit or acceptance page: fail closed. */
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface InviteStaffDependencies {
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
  readonly targets: LinkTargets;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Invites a Staff member with a role (identity design 3.4 `(none)` → `pending`, 5.4 R1, R3 and
 * R11, 5.5; AC 35, AC 37; R12; slice 11). Rule `permissions [identity.team-member.invite]`
 * (protected, so in Phase 2 only the Seller Owner holds it), denied while the seller is not
 * approved. The seller is the actor's (R6), never input; the actor is the inviter: the
 * invitation carries its account id, and the acceptance checks again that it still stands
 * (Hassan 14.2).
 *
 * Read before the unit, failing closed (`access.unavailable`): the Staff lifetime, the member
 * limit and the seller acceptance page. In one **serializable** unit (the member limit is a
 * counted read of memberships and invitations):
 *
 * 1. The actor, re-read (`readActingSellerGrants`): still an active, verified member of its
 *    seller, which is still `approved`, holding the Seller Owner role and the rule's key; else
 *    `access.denied`.
 * 2. The role: a seller role in the actor's reach (a shared role or this seller's custom role;
 *    another seller's is `role.unknown`, byte-identical to a missing one) and
 *    `GrantPolicy.canGrant` (`role.not-grantable`): the actor holds every key it confers, a
 *    protected key is never grantable in seller scope in Phase 2, and the Seller Owner role is
 *    never granted (HF5).
 * 3. The mail counters, `mail.account` of the address and `mail.origin` (6.8): used up is
 *    `request.throttled`, and nothing commits.
 * 4. One pending invitation per address and seller: a stale one (expired or never dispatched,
 *    M7) is revoked and replaced, else `invitation.already-pending`.
 * 5. The member limit: active members plus pending Staff invitations (`member.limit`).
 * 6. The invitation, without a token: `identity.invitation-issued.v1` (the mail handler mints the
 *    token and sends E10) and the audit row `identity.invitation.issued` (`staff`).
 *
 * The answer is the same for any address (3.4, 6.7): an address that already has a seller-side
 * account is not refused here, so the inviter learns nothing about it; its acceptance is refused.
 * The address is never logged or audited.
 */
export class InviteStaff extends UseCase<InviteStaffInput, InviteStaffOutput, InviteStaffFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.invite-staff',
    rule: { kind: 'permissions', allOf: [TEAM_MEMBER_INVITE.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('InviteStaff');

  constructor(
    gate: UseCaseGate,
    private readonly deps: InviteStaffDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: InviteStaffInput,
  ): Promise<Result<InviteStaffOutput, InviteStaffFailure>> {
    const result = await this.issue(context, input);
    this.#logger.log({
      msg: 'identity.invite-staff',
      outcome: result.ok ? result.value.code : result.error.code,
      ...(result.ok
        ? { invitationId: result.value.invitationId, replaced: result.value.replaced }
        : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async issue(
    context: CallContext,
    input: InviteStaffInput,
  ): Promise<Result<InviteStaffOutput, InviteStaffFailure>> {
    const { market } = context;
    const self = sellerSubjectOf(context);
    if (self === null || self.sellerId === null) return err({ code: 'access.denied' });
    const sellerId = self.sellerId;
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    const { policy, targets } = this.deps;
    const lifetime = policy.invitationLifetimeMinutes(market, 'staff');
    const limit = policy.sellerMemberLimit(market);
    if (
      lifetime === null ||
      limit === null ||
      targets.target(market, 'seller', 'accept-invitation') === null
    ) {
      return err({ code: 'access.unavailable' });
    }

    try {
      return await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<InviteStaffOutput, InviteStaffFailure>> => {
          const { invitations, outbox, audit } = this.deps;
          const now = this.deps.clock.now();
          const reading = await readActingSellerGrants(this.deps, market, self, [], RULE_KEYS);
          if (reading === null) return err({ code: 'access.denied' });
          const role = await this.deps.roles.findById(market, input.roleId);
          if (role === null || !roleIsInActorsReach(role, self)) {
            return err({ code: 'role.unknown' });
          }
          const granted = roleGrantVerdict(reading.actor, role, this.deps);
          if (!granted.ok) {
            this.#logger.log({
              msg: 'identity.invite-staff.not-grantable',
              reason: granted.error.reason,
              marketId: market.marketId,
              correlationId: context.correlationId,
            });
            return err({ code: 'role.not-grantable' });
          }
          // Throttle rows first, then the invitation rows (data design 3.3).
          const verdict = await reserveInvitationMail(
            this.deps,
            market,
            email.value.normalized,
            input.origin,
            now,
          );
          if (!verdict.allowed) {
            return err({ code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds });
          }
          let replaced = false;
          const pending = await invitations.findPendingFor(
            market,
            sellerId,
            email.value.normalized,
          );
          if (pending !== null) {
            if (!pending.replaceableAt(now, lifetime)) {
              return err({ code: 'invitation.already-pending' });
            }
            pending.revoke(now);
            await invitations.save(market, pending);
            await outbox.append(context, pending.pendingEvents);
            await audit.record(
              context,
              InvitationRevokedAudit.entry(pending.state.id, {
                after: { kind: pending.state.kind, roleId: pending.state.roleId },
              }),
            );
            replaced = true;
          }
          const members = await this.deps.memberships.activeMembersOf(market, sellerId);
          const open = await invitations.countPendingStaff(market, sellerId);
          if (members.length + open >= limit) return err({ code: 'member.limit' });
          const invitation = Invitation.issue({
            id: this.deps.ids.next<'Invitation'>(),
            marketId: market.marketId,
            kind: 'staff',
            email: email.value,
            roleId: role.state.id,
            sellerId,
            invitedByAccountId: self.accountId,
            now,
          });
          await invitations.add(market, invitation);
          await outbox.append(context, invitation.pendingEvents);
          await audit.record(
            context,
            InvitationIssuedAudit.entry(invitation.state.id, {
              after: { kind: 'staff', roleId: role.state.id },
            }),
          );
          return ok({ code: 'invitation.issued', invitationId: invitation.state.id, replaced });
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      if (!(error instanceof InvitationAlreadyPendingError)) throw error;
      return err({ code: 'invitation.already-pending' });
    }
  }
}
