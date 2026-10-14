import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import { TEAM_MEMBER_INVITE } from '../../contracts/permissions';
import type { ActedOnAccount, CannotActOn, GrantingActor } from '../../domain/grant-policy';
import { LastHolderPolicy, type LastHolder } from '../../domain/last-holder-policy';
import { isSystemRole, mayActOnAdmin } from '../accounts/admin-verdicts';
import { invitationReissuableAt, type InvitationState } from '../../domain/invitation';
import type { Role } from '../../domain/role';
import type { InviterRefusal } from '../roles/granting';
import {
  readActingGrants,
  roleGrantVerdict,
  roleIsInActorsReach,
  type ActingGrantDependencies,
  type GrantReading,
  type GrantSubject,
} from '../roles/granting';
import type { RoleRepository } from '../ports/seller-team.repository';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import { isActingAsSession } from './access-decision-reads';

// What the seller team commands share after their gate (identity design 3.4, 5.4, 5.5; slice 11),
// each in one function, so the commands, the acceptance and the team list's hints run the same
// code. A function here reads only what its caller passes or the ports it is given; the caller
// decides the unit (a command's serializable one, the list's read-only one).

/** The ports {@link readActingSellerGrants} reads, on top of the grant read. */
export interface SellerActingDependencies extends ActingGrantDependencies {
  readonly memberships: Pick<SellerMembershipRepository, 'findActiveByAccount'>;
  readonly sellerAccess: Pick<SellerAccessRepository, 'findById'>;
}

/**
 * The calling seller actor as a grant subject, or null (`access.denied`): a seller-side actor
 * with a seller, never an acting-as session (SEL-08). The seller is the session's (R6), never
 * input.
 */
export function sellerSubjectOf(context: CallContext): GrantSubject | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') return null;
  if (actor.sellerId === null || isActingAsSession(actor)) return null;
  return { accountId: actor.accountId, population: 'seller', sellerId: actor.sellerId };
}

/** Whether the seller's access is `approved` now (3.4: Staff are invited and accepted only then). */
export async function sellerIsApproved(
  sellerAccess: Pick<SellerAccessRepository, 'findById'>,
  market: MarketContext,
  sellerId: Id<'Seller'>,
): Promise<boolean> {
  return (await sellerAccess.findById(market, sellerId))?.isApproved === true;
}

/**
 * The actor of a seller team command re-checked **in the unit that writes** (Mohammad C1, Hassan
 * I1 on PR #187, as `readActingGrants` for admins), with the seller side of it: the actor is
 * still an active member of its own seller (a removed member's session is revoked, but a request
 * already past the gate must not write), the seller is still `approved`, and the actor holds the
 * Seller Owner role: in Phase 2 managing the team is the owner's alone (5.4 R11 narrowing, AC
 * 35), whichever keys a role may hold. Null: the caller answers `access.denied`.
 */
export async function readActingSellerGrants(
  deps: SellerActingDependencies,
  market: MarketContext,
  self: GrantSubject,
  targets: readonly GrantSubject[],
  requiredKeys: readonly string[],
): Promise<GrantReading | null> {
  const reading = await readActingSellerMember(deps, market, self, targets, requiredKeys);
  return reading !== null && reading.actor.holdsSystemRole ? reading : null;
}

/**
 * {@link readActingSellerGrants} without the Seller Owner requirement: the read of the team
 * list, which a member holding only `identity.team-member.view` may call (view-only, `ux.md`
 * F11 step 1). Still an active member of its own seller, which is still approved, holding the
 * keys asked.
 */
export async function readActingSellerMember(
  deps: SellerActingDependencies,
  market: MarketContext,
  self: GrantSubject,
  targets: readonly GrantSubject[],
  requiredKeys: readonly string[],
): Promise<GrantReading | null> {
  const sellerId = self.sellerId;
  if (sellerId === null) return null;
  const membership = await deps.memberships.findActiveByAccount(market, self.accountId);
  if (membership === null || membership.state.sellerId !== sellerId) return null;
  if (!(await sellerIsApproved(deps.sellerAccess, market, sellerId))) return null;
  return readActingGrants(deps, market, self, targets, requiredKeys);
}

/** Whether `account` is an active member of `sellerId`, read in the caller's unit. */
export async function isActiveMemberOf(
  memberships: Pick<SellerMembershipRepository, 'findActiveByAccount'>,
  market: MarketContext,
  accountId: Id<'Account'>,
  sellerId: Id<'Seller'>,
): Promise<boolean> {
  const membership = await memberships.findActiveByAccount(market, accountId);
  return membership !== null && membership.state.sellerId === sellerId;
}

/**
 * Whether the inviter of a Staff invitation could still issue it now (identity design 3.4;
 * Hassan 14.2): an active, verified member of the invitation's seller who holds the Seller Owner
 * role and `identity.team-member.invite`, with the seller `approved`, and who passes
 * `GrantPolicy.canGrant` for the role. The acceptance's closing unit and a re-send call it, so an
 * invitation its inviter could no longer issue is never accepted nor sent again.
 */
export async function staffInviterMayStillGrant(
  deps: SellerActingDependencies & { readonly permissions: Pick<SealedPermissionCatalogue, 'get'> },
  market: MarketContext,
  sellerId: Id<'Seller'>,
  inviterId: Id<'Account'> | null,
  role: Role,
): Promise<Result<void, InviterRefusal>> {
  if (inviterId === null) return err('inviter-inactive');
  const self: GrantSubject = { accountId: inviterId, population: 'seller', sellerId };
  const reading = await readActingSellerGrants(deps, market, self, [], [TEAM_MEMBER_INVITE.key]);
  if (reading === null) return err('inviter-inactive');
  return roleGrantVerdict(reading.actor, role, deps).ok
    ? ok(undefined)
    : err('inviter-cannot-grant');
}

export type StaffResendRefusal =
  | { readonly code: 'invitation.rejected'; readonly inviterRefusal?: InviterRefusal }
  | { readonly code: 'role.not-grantable' };

/** The ports {@link staffInvitationResendVerdict} reads. */
export interface StaffResendDependencies extends SellerActingDependencies {
  readonly roles: Pick<RoleRepository, 'findById'>;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
}

/**
 * The guards of re-sending a Staff invitation once it is found (identity design 3.4): pending
 * and of the actor's own seller (the caller has checked the seller); its role still a seller role
 * in the actor's reach (R12, R9); `GrantPolicy.canGrant` for the actor (`role.not-grantable`); its
 * inviter could still issue it; and before `createdAt` plus the kind's lifetime (Mohammad C2).
 * It reads only the fields named, so a summary without the token hash serves as well as the
 * aggregate's state. Answers the role.
 */
export async function staffInvitationResendVerdict(
  deps: StaffResendDependencies,
  market: MarketContext,
  actor: { readonly self: GrantSubject; readonly view: GrantingActor },
  invitation: Pick<
    InvitationState,
    'invitedByAccountId' | 'state' | 'roleId' | 'createdAt' | 'sellerId'
  >,
  now: Temporal.Instant,
  lifetimeMinutes: number,
): Promise<Result<Role, StaffResendRefusal>> {
  const sellerId = actor.self.sellerId;
  if (invitation.state !== 'pending' || sellerId === null || invitation.sellerId !== sellerId) {
    return err({ code: 'invitation.rejected' });
  }
  const role = await deps.roles.findById(market, invitation.roleId);
  if (role === null || !roleIsInActorsReach(role, actor.self)) {
    return err({ code: 'invitation.rejected' });
  }
  if (!roleGrantVerdict(actor.view, role, deps).ok) return err({ code: 'role.not-grantable' });
  const inviter = await staffInviterMayStillGrant(
    deps,
    market,
    sellerId,
    invitation.invitedByAccountId,
    role,
  );
  if (!inviter.ok) return err({ code: 'invitation.rejected', inviterRefusal: inviter.error });
  if (!invitationReissuableAt(invitation, now, lifetimeMinutes)) {
    return err({ code: 'invitation.rejected' });
  }
  return ok(role);
}

/**
 * The target-dependent guards of changing a member's role or removing the member, after the
 * actor and the target are read (identity design 5.4 R1, R3, 5.5; slice 11): `mayActOnAdmin`
 * (`GrantPolicy.canActOn`, which refuses oneself and a target holding a key the actor lacks, and
 * R3 on a holder of the system role), then, when the target holds the Seller Owner role and
 * would lose it, `LastHolderPolicy` over the holders `holders` reads (only then, so a command
 * counts in its own unit and only when it must). The one verdict of the two commands and of the
 * team list's hints.
 */
export async function memberChangeVerdict(input: {
  readonly actor: GrantingActor;
  readonly target: ActedOnAccount;
  readonly targetRoleId: Id<'Role'> | null;
  readonly systemRoleId: Id<'Role'> | null;
  readonly holders: () => Promise<readonly Id<'Account'>[]>;
}): Promise<Result<void, CannotActOn | LastHolder>> {
  const acted = mayActOnAdmin(input.actor, input.target, input.targetRoleId, input.systemRoleId);
  if (!acted.ok) return acted;
  if (isSystemRole(input.targetRoleId, input.systemRoleId)) {
    return LastHolderPolicy.allowsLosing(await input.holders(), input.target.accountId);
  }
  return ok(undefined);
}
