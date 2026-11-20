import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type {
  ApplyOutcome,
  ChangeImpact,
  RevertOutcome,
  RevertRequest,
  SystemChangeApplier,
  SystemChangeReverter,
} from '../../../../platform/change-review/change-review';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PLATFORM_ROLE_DELETE } from '../../contracts/permissions';
import {
  AccountStatusRevertedAudit,
  InvitationRevertedAudit,
  RoleCreationRevertedAudit,
  RoleDeletionApprovedAudit,
} from '../../domain/audit';
import { LastHolderPolicy } from '../../domain/last-holder-policy';
import type { Role } from '../../domain/role';
import { writeAccountStatus } from '../accounts/account-status';
import { isSystemRole } from '../accounts/admin-verdicts';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { readActingGrants, roleIsInActorsReach, type GrantSubject } from '../roles/granting';
import { roleDeleteVerdict, roleEditVerdict } from '../roles/role-editing';
import {
  adminOf,
  decider,
  describeAdmins,
  describeRoles,
  holdsRole,
  idOf,
  labelsOrNone,
  roleHolderImpact,
  sameList,
  type PeopleLabelReads,
  type PeopleReverterDependencies,
} from './people-reverters';

// The creations and the delete of area people (owner decision of 18 Nov 2026, "mixed"): creating
// a custom platform role and inviting an admin go live at once and are reviewed after (a reverter
// undoes them), deleting a custom platform role waits for another admin's approval (an applier
// does it then). Each runs inside System requests' open serializable decision unit with the
// deciding admin's context, writes identity's own tables, events and audit rows (naming the
// request), and opens neither a unit nor a review. Every outcome but `reverted` / `applied`
// writes nothing; the request stays open.
//
// A revert only narrows access (Hassan, the rule of PR #912 and #913): it deletes a role nobody
// holds, revokes a pending invitation, or disables the admin who accepted one (every session
// revoked, every challenge void, as a disable does), and keeps the last Platform Administrator
// who can sign in (`LastHolderPolicy`), else `not-permitted`.

/** The ports of the creation reverters and the appliers (role delete, sensitive invitation). */
export interface PeopleCreationDependencies extends PeopleReverterDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly invitations: InvitationRepository;
  readonly grants: RoleGrantReader;
  /** The admin invitation lifetime (a held invitation past it is gone). */
  readonly policy: Pick<IdentityMarketPolicy, 'invitationLifetimeMinutes'>;
}

const isDeclaredBy =
  (deps: PeopleReverterDependencies) =>
  (key: string): boolean =>
    deps.permissions.get(key) !== undefined;

/** A custom platform role of the context Market, or null. */
async function customPlatformRole(
  deps: PeopleReverterDependencies,
  context: CallContext,
  subjectRef: string,
): Promise<Role | null> {
  const roleId = idOf<'Role'>(subjectRef);
  if (roleId === null) return null;
  const role = await deps.roles.findById(context.market, roleId);
  return role !== null && role.state.scope === 'platform' && role.state.kind === 'custom'
    ? role
    : null;
}

/** Whether anybody holds the role now (read in the open unit). */
async function isHeld(deps: PeopleReverterDependencies, context: CallContext, role: Role) {
  return (await deps.assignments.heldRoles(context.market, [role.state.id])).has(role.state.id);
}

/**
 * Deletes again a custom platform role whose creation is rejected or withdrawn: only while it
 * still confers exactly the keys it was created with (a rename alone does not matter) and nobody
 * holds it. Gone: the role no longer exists (deleted meanwhile). Changed since: its keys changed.
 * Not permitted: an account holds it (its assignment is reviewed on its own; undo that first).
 */
export async function revertRoleCreation(
  deps: PeopleReverterDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<RevertOutcome> {
  decider(context);
  if (request.after.exists !== true) return 'gone';
  const role = await customPlatformRole(deps, context, request.subjectRef);
  if (role === null) return 'gone';
  if (!sameList(role.state.permissionKeys, request.after.permissionKeys)) return 'changed-since';
  if (await isHeld(deps, context, role)) return 'not-permitted';
  const isDeclared = isDeclaredBy(deps);
  const removed = role.remove({ isDeclared, now: deps.clock.now() });
  await deps.roles.deleteCustom(context.market, removed);
  await deps.outbox.append(context, removed.pendingEvents);
  await deps.audit.record(
    context,
    RoleCreationRevertedAudit.entry(role.state.id, {
      before: { scope: 'platform', removedKeys: role.state.permissionKeys.filter(isDeclared) },
      after: { requestId: request.requestId },
    }),
  );
  return 'reverted';
}

/**
 * Undoes an admin invitation that is rejected or withdrawn. Still pending (expired or not): it is
 * revoked, as the inviter's revoke does. Accepted: the account it created is disabled, as the
 * enabling's revert does (every session revoked, every challenge void, under the account's
 * credential lock), never the last Platform Administrator who can sign in; an account no longer
 * active is `changed-since`. Revoked meanwhile: `changed-since`. Gone: the invitation was purged
 * (30 days after its decision), or is not an admin invitation of this Market.
 */
export async function revertAdminInvitation(
  deps: PeopleCreationDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<RevertOutcome> {
  decider(context);
  const { market } = context;
  const invitationId = idOf<'Invitation'>(request.subjectRef);
  if (invitationId === null || request.after.exists !== true) return 'gone';
  // The acceptance's lock: an acceptance racing this revert either commits first (and the
  // account is disabled here) or reads the revoked invitation and refuses.
  await deps.invitations.lockForAcceptance(market, invitationId);
  const invitation = await deps.invitations.findById(market, invitationId);
  if (invitation === null || invitation.state.kind !== 'admin') return 'gone';
  if (invitation.state.roleId !== request.after.roleId) return 'gone';
  const now = deps.clock.now();
  if (invitation.state.state === 'revoked') return 'changed-since';
  if (invitation.state.state === 'pending') {
    if (!invitation.revoke(now).ok) return 'changed-since';
    await deps.invitations.save(market, invitation);
    await deps.outbox.append(context, invitation.pendingEvents);
    await deps.audit.record(
      context,
      InvitationRevertedAudit.entry(invitation.state.id, {
        after: { kind: 'admin', roleId: invitation.state.roleId, requestId: request.requestId },
      }),
    );
    return 'reverted';
  }
  const accountId = invitation.state.acceptedAccountId;
  if (accountId === null) return 'gone';
  // The lock the sign-in closing units take before they re-check the status (HF11).
  if (!(await deps.accounts.lockCredential(market, accountId))) return 'gone';
  const account = await deps.accounts.findById(market, accountId);
  if (account === null || account.state.population !== 'admin') return 'gone';
  if (account.state.status !== 'active') return 'changed-since';
  const systemRoleId = (await deps.roles.findSystemRole(market, 'platform'))?.state.id ?? null;
  const roleId = (await deps.assignments.findByAccount(market, accountId))?.state.roleId ?? null;
  if (isSystemRole(roleId, systemRoleId)) {
    const holders = await deps.assignments.activeHoldersOf(market, systemRoleId!);
    if (!LastHolderPolicy.allowsLosing(holders, accountId).ok) return 'not-permitted';
  }
  const written = await writeAccountStatus(deps, context, account, 'disabled', now);
  if (!written.ok) return 'changed-since';
  await deps.audit.record(
    context,
    AccountStatusRevertedAudit.entry(accountId, {
      before: { status: 'active' },
      after: { status: 'disabled', population: 'admin', requestId: request.requestId },
    }),
  );
  return 'reverted';
}

/** The approving admin as a grant subject, or null (System requests refuses any other actor). */
function approverOf(context: CallContext): GrantSubject | null {
  const admin = adminOf(context);
  return admin === null ? null : { accountId: admin, population: 'admin', sellerId: null };
}

const DELETE_KEYS = [PLATFORM_ROLE_DELETE.key];

/**
 * Deletes a custom platform role whose delete another admin approved, as that admin: only while
 * the role still holds the name, keys and version it had when the delete was asked for
 * (`changed-since` otherwise), nobody holds it, and the approving admin could delete it
 * themselves now (an active, verified admin holding `identity.platform-role.delete` who can grant
 * the role, R1 and R11): else `not-permitted`. Gone: the role no longer exists.
 */
export async function applyRoleDeletion(
  deps: PeopleCreationDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<ApplyOutcome> {
  decider(context);
  const self = approverOf(context)!;
  if (request.after.action !== 'delete') return 'gone';
  const acting = await readActingGrants(deps, context.market, self, [], DELETE_KEYS);
  if (acting === null) return 'not-permitted';
  const role = await customPlatformRole(deps, context, request.subjectRef);
  if (role === null || !roleIsInActorsReach(role, self)) return 'gone';
  const { before } = request;
  if (
    role.state.version !== before.version ||
    (role.state.name ?? null) !== before.name ||
    !sameList(role.state.permissionKeys, before.permissionKeys)
  ) {
    return 'changed-since';
  }
  const held = await isHeld(deps, context, role);
  if (!roleDeleteVerdict(acting.actor, role, held, deps).ok) return 'not-permitted';
  const isDeclared = isDeclaredBy(deps);
  const removed = role.remove({ isDeclared, now: deps.clock.now() });
  await deps.roles.deleteCustom(context.market, removed);
  await deps.outbox.append(context, removed.pendingEvents);
  await deps.audit.record(
    context,
    RoleDeletionApprovedAudit.entry(role.state.id, {
      before: { scope: 'platform', removedKeys: role.state.permissionKeys.filter(isDeclared) },
      after: { requestId: request.requestId },
    }),
  );
  return 'applied';
}

/**
 * The approval's check before its unit (fail closed): the approving admin is an active, verified
 * admin holding `identity.platform-role.delete` and, while the role exists, could edit it (R1,
 * R11). Read in a read-only unit of its own; `applyRoleDeletion` checks it all again in the unit.
 */
export async function checkRoleDeletion(
  deps: PeopleCreationDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<'ok' | 'not-permitted'> {
  const self = approverOf(context);
  if (self === null) return 'not-permitted';
  const answer = await deps.unitOfWork.run(
    context.market,
    async () => {
      const acting = await readActingGrants(deps, context.market, self, [], DELETE_KEYS);
      if (acting === null) return ok('not-permitted' as const);
      const role = await customPlatformRole(deps, context, request.subjectRef);
      if (role === null) return ok('ok' as const);
      return ok(
        roleEditVerdict(acting.actor, role, deps).ok ? ('ok' as const) : ('not-permitted' as const),
      );
    },
    { readOnly: true },
  );
  return answer.ok ? answer.value : 'not-permitted';
}

/**
 * Whether the deciding admin is the subject of an admin invitation: the account that accepted
 * it, or (while pending) the account of the invited address. Read in the decision's open unit;
 * any actor that is not a signed-in admin counts as interested (fail closed).
 */
export async function isInvitee(
  deps: PeopleCreationDependencies,
  context: CallContext,
  subjectRef: string,
): Promise<boolean> {
  const admin = adminOf(context);
  if (admin === null) return true;
  const invitationId = idOf<'Invitation'>(subjectRef);
  if (invitationId === null) return false;
  const invitation = await deps.invitations.findById(context.market, invitationId);
  if (invitation === null) return false;
  if (invitation.state.acceptedAccountId === admin) return true;
  const invited = invitation.state.email;
  if (invited === null) return false;
  const account = await deps.accounts.findById(context.market, admin);
  return account !== null && account.state.email.normalized === invited.normalized;
}

/**
 * The display name of the admin who accepted each invitation among `subjectRefs`; a pending
 * invitation has no name (only an address, never shown). The invitations are read in a read-only
 * unit of its own; the names through identity's own label read, with the viewer's context.
 */
function describeInvitations(
  deps: PeopleCreationDependencies,
  labels: PeopleLabelReads,
  context: CallContext,
  subjectRefs: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const kind = 'identity.admin-invitation';
  return labelsOrNone(context, kind, async () => {
    if (adminOf(context) === null) return new Map();
    const read = await deps.unitOfWork.run(
      context.market,
      async () => {
        const accepted = new Map<string, Id<'Account'>>();
        for (const ref of new Set(subjectRefs)) {
          const invitationId = idOf<'Invitation'>(ref);
          if (invitationId === null) continue;
          const invitation = await deps.invitations.findById(context.market, invitationId);
          if (invitation?.state.kind === 'admin' && invitation.state.acceptedAccountId !== null) {
            accepted.set(ref, invitation.state.acceptedAccountId);
          }
        }
        return ok(accepted);
      },
      { readOnly: true },
    );
    if (!read.ok || read.value.size === 0) return new Map();
    const names = await describeAdmins(labels, context, kind, [...read.value.values()]);
    const labelled = new Map<string, string>();
    for (const [ref, accountId] of read.value) {
      const name = names.get(accountId);
      if (name !== undefined) labelled.set(ref, name);
    }
    return labelled;
  });
}

/** `identity.platform-role-creation`: a custom platform role created (reviewed after). */
export class PlatformRoleCreationReverter implements SystemChangeReverter {
  constructor(
    private readonly deps: PeopleCreationDependencies,
    private readonly labels: PeopleLabelReads,
  ) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertRoleCreation(this.deps, context, request);
  }

  /** The decider holds the created role now (a change to their own access). */
  isInterested(context: CallContext, request: RevertRequest): Promise<boolean> {
    return holdsRole(this.deps, context, request.subjectRef);
  }

  /** The role's name, for a viewer who may list the platform roles (else none). */
  describe(context: CallContext, subjectRefs: readonly string[]) {
    return describeRoles(this.labels, context, 'identity.platform-role-creation', subjectRefs);
  }
}

/** `identity.admin-invitation`: an admin invited (reviewed after). */
export class AdminInvitationReverter implements SystemChangeReverter {
  constructor(
    private readonly deps: PeopleCreationDependencies,
    private readonly labels: PeopleLabelReads,
  ) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertAdminInvitation(this.deps, context, request);
  }

  /** The decider is the invitee (the account that accepted it, or the invited address's). */
  isInterested(context: CallContext, request: RevertRequest): Promise<boolean> {
    return isInvitee(this.deps, context, request.subjectRef);
  }

  /** The display name of the admin who accepted it; never the invited address. */
  describe(context: CallContext, subjectRefs: readonly string[]) {
    return describeInvitations(this.deps, this.labels, context, subjectRefs);
  }
}

/** `identity.platform-role-deletion`: a custom platform role's delete (waits for approval). */
export class PlatformRoleDeletionApplier implements SystemChangeApplier {
  constructor(
    private readonly deps: PeopleCreationDependencies,
    private readonly labels: PeopleLabelReads,
  ) {}

  apply(context: CallContext, request: RevertRequest): Promise<ApplyOutcome> {
    return applyRoleDeletion(this.deps, context, request);
  }

  check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'> {
    return checkRoleDeletion(this.deps, context, request);
  }

  /** The decider holds the role now (an unheld role cannot be deleted anyway). */
  isInterested(context: CallContext, request: RevertRequest): Promise<boolean> {
    return holdsRole(this.deps, context, request.subjectRef);
  }

  /** The role's name, for a viewer who may list the platform roles (else none). */
  describe(context: CallContext, subjectRefs: readonly string[]) {
    return describeRoles(this.labels, context, 'identity.platform-role-deletion', subjectRefs);
  }

  /** The admins who hold the role (a held role is not deleted: the approval answers so). */
  impact(
    context: CallContext,
    request: RevertRequest,
    signal?: AbortSignal,
  ): Promise<ChangeImpact | null> {
    return roleHolderImpact(this.deps, this.labels, context, request.subjectRef, signal);
  }
}
