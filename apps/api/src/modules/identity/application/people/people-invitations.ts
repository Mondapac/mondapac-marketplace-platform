import { ok } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import type {
  ApplyOutcome,
  RevertRequest,
  SystemChangeApplier,
} from '../../../../platform/change-review/change-review';
import { ADMIN_ACCOUNT_INVITE } from '../../contracts/permissions';
import { InvitationApprovedAudit } from '../../domain/audit';
import type { Invitation } from '../../domain/invitation';
import type { Role } from '../../domain/role';
import {
  inviterMayStillGrant,
  readActingGrants,
  roleGrantVerdict,
  roleIsInActorsReach,
  type GrantReading,
  type GrantSubject,
} from '../roles/granting';
import { isInvitee, type PeopleCreationDependencies } from './people-creations';
import { adminOf, decider, idOf } from './people-reverters';

// An admin invitation to a sensitive role waits for another admin's approval (owner decision of
// 18 Nov 2026, 14:06Z). `InviteAdmin` stores it held (pending, no issue event: no mail, no token)
// and files `identity.admin-invitation-sensitive` with values `{roleId, roleVersion}` before and
// `{action: 'invite', roleId}` after, never the address. Its approval runs here, inside System
// requests' open serializable decision unit, as the approving admin: it releases the invitation,
// which records the issue event the mail handler dispatches on, and audits
// `identity.invitation.approved` naming the request. A reject or withdraw asks nothing here:
// nothing was sent, and the held row is revoked by the inviter or purged as a never-sent invitation
// once its kind's lifetime has passed.

/** The keys of `InviteAdmin`'s rule (`allOf`): System requests checks the approver holds them. */
export const INVITE_ADMIN_KEYS: readonly string[] = Object.freeze([ADMIN_ACCOUNT_INVITE.key]);

/** The approving admin as a grant subject, or null (System requests refuses any other actor). */
function approverOf(context: CallContext): GrantSubject | null {
  const admin = adminOf(context);
  return admin === null ? null : { accountId: admin, population: 'admin', sellerId: null };
}

/** The approver's grant, read in the open unit: active, verified, holding the invite keys. */
function approverGrants(
  deps: PeopleCreationDependencies,
  market: MarketContext,
  self: GrantSubject,
): Promise<GrantReading | null> {
  return readActingGrants(deps, market, self, [], INVITE_ADMIN_KEYS);
}

/** The held admin invitation of the request, or null when it is not one of this Market. */
async function invitationOf(
  deps: PeopleCreationDependencies,
  market: MarketContext,
  subjectRef: string,
): Promise<Invitation | null> {
  const invitationId = idOf<'Invitation'>(subjectRef);
  if (invitationId === null) return null;
  const invitation = await deps.invitations.findById(market, invitationId);
  return invitation !== null && invitation.state.kind === 'admin' ? invitation : null;
}

/** The invitation's role, when it is a platform role in the approver's reach. */
async function roleOf(
  deps: PeopleCreationDependencies,
  market: MarketContext,
  invitation: Invitation,
  self: GrantSubject,
): Promise<Role | null> {
  const role = await deps.roles.findById(market, invitation.state.roleId);
  return role !== null && roleIsInActorsReach(role, self) ? role : null;
}

/**
 * Sends a held admin invitation whose approval another admin gave, as that admin. In order:
 *
 * - the approver is an active, verified admin holding `identity.admin-account.invite`, and could
 *   give the role now (`roleGrantVerdict`: every key it confers, a protected one or the
 *   Platform Administrator only with the system role; R1, R3, R11), else `not-permitted`;
 * - the invitation (under the acceptance's lock) is still held and pending, for the role it was
 *   filed with, else `changed-since` (revoked or replaced meanwhile); missing, or past its kind's
 *   lifetime as a never-sent invitation (it can then be replaced and is purged), `gone`;
 * - the role still exists at the version it had when asked (`changed-since` after an edit;
 *   `gone` once deleted);
 * - the inviter could still issue it (`inviterMayStillGrant`, as the acceptance checks) and the
 *   address has no admin account yet, else `not-permitted`.
 *
 * Then the invitation is released (`identity.invitation-issued.v1`, so the mail and its token
 * follow) and `identity.invitation.approved` is audited with the request id. The mail counters
 * were spent when it was asked for. Any other outcome writes nothing.
 */
export async function applySensitiveInvitation(
  deps: PeopleCreationDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<ApplyOutcome> {
  decider(context);
  const { market } = context;
  const self = approverOf(context)!;
  if (request.after.action !== 'invite') return 'gone';
  const lifetime = deps.policy.invitationLifetimeMinutes(market, 'admin');
  if (lifetime === null) return 'not-permitted';
  const acting = await approverGrants(deps, market, self);
  if (acting === null) return 'not-permitted';
  const invitationId = idOf<'Invitation'>(request.subjectRef);
  if (invitationId === null) return 'gone';
  // The acceptance's lock: a revoke or a replace racing this approval commits first or waits.
  await deps.invitations.lockForAcceptance(market, invitationId);
  const invitation = await invitationOf(deps, market, request.subjectRef);
  if (invitation === null) return 'gone';
  const { state } = invitation;
  if (state.state !== 'pending' || !state.heldForApproval) return 'changed-since';
  if (state.roleId !== request.before.roleId) return 'changed-since';
  const now = deps.clock.now();
  if (invitation.replaceableAt(now, lifetime)) return 'gone';
  const role = await roleOf(deps, market, invitation, self);
  if (role === null) return 'gone';
  if (role.state.version !== request.before.roleVersion) return 'changed-since';
  if (!roleGrantVerdict(acting.actor, role, deps).ok) return 'not-permitted';
  const inviter = state.invitedByAccountId;
  if (inviter === null || !(await inviterMayStillGrant(deps, market, inviter, role)).ok) {
    return 'not-permitted';
  }
  const address = state.email;
  if (address === null) return 'changed-since';
  if ((await deps.accounts.findByEmail(market, 'admin', address.normalized)) !== null) {
    return 'not-permitted';
  }
  if (!invitation.release(now).ok) return 'changed-since';
  await deps.invitations.save(market, invitation);
  await deps.outbox.append(context, invitation.pendingEvents);
  await deps.audit.record(
    context,
    InvitationApprovedAudit.entry(state.id, {
      after: { kind: 'admin', roleId: role.state.id, requestId: request.requestId },
    }),
  );
  return 'applied';
}

/**
 * The approval's check before its unit (fail closed): the approving admin is an active, verified
 * admin holding the invite keys and, while the invitation and its role exist, could give that
 * role (R1, R3, R11). Read in a read-only unit of its own; `applySensitiveInvitation` checks it
 * all again in the decision unit.
 */
export async function checkSensitiveInvitation(
  deps: PeopleCreationDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<'ok' | 'not-permitted'> {
  const self = approverOf(context);
  if (self === null) return 'not-permitted';
  const { market } = context;
  const answer = await deps.unitOfWork.run(
    market,
    async () => {
      const acting = await approverGrants(deps, market, self);
      if (acting === null) return ok('not-permitted' as const);
      const invitation = await invitationOf(deps, market, request.subjectRef);
      if (invitation === null) return ok('ok' as const);
      const role = await roleOf(deps, market, invitation, self);
      if (role === null) return ok('ok' as const);
      return ok(
        roleGrantVerdict(acting.actor, role, deps).ok
          ? ('ok' as const)
          : ('not-permitted' as const),
      );
    },
    { readOnly: true },
  );
  return answer.ok ? answer.value : 'not-permitted';
}

/** `identity.admin-invitation-sensitive`: a sensitive role's admin invitation (waits for approval). */
export class SensitiveAdminInvitationApplier implements SystemChangeApplier {
  // No `describe`: a held invitation has only an address, never shown in the queue.
  constructor(private readonly deps: PeopleCreationDependencies) {}

  apply(context: CallContext, request: RevertRequest): Promise<ApplyOutcome> {
    return applySensitiveInvitation(this.deps, context, request);
  }

  check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    return checkSensitiveInvitation(this.deps, context, request);
  }

  /** The decider is the invitee: the admin account of the invited address, if one exists. */
  isInterested(context: CallContext, request: RevertRequest): Promise<boolean> {
    return isInvitee(this.deps, context, request.subjectRef);
  }
}
