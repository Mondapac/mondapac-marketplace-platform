import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import type {
  RevertOutcome,
  RevertRequest,
  SystemChangeReverter,
} from '../../../../platform/change-review/change-review';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import {
  AccountRoleRevertedAudit,
  AccountStatusRevertedAudit,
  RoleRevertedAudit,
} from '../../domain/audit';
import { LastHolderPolicy } from '../../domain/last-holder-policy';
import { normalizeRoleName, parseRoleName } from '../../domain/role';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import { writeAccountStatus } from '../accounts/account-status';
import { isSystemRole } from '../accounts/admin-verdicts';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/seller-team.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import { grantedRoleOf } from '../roles/granting';
import { parseRoleKeys } from '../roles/role-editing';
import { isActingAsSession } from '../sellers/access-decision-reads';

// The reverters identity registers with System requests (area people). Each runs inside the
// decision's open serializable unit with the deciding admin's context (the author withdrawing, or
// a reviewer rejecting) after the reviewer's step-up was spent (every people request is high
// risk), and writes identity's own tables, events and audit rows; none opens a unit or a review.
//
// A revert never widens access (Hassan, the rule of PR #912 and #913):
// - a role edit's revert runs only when the keys before are a subset of the keys now (it removes
//   keys or only renames); one that would add a key answers `not-permitted`;
// - an admin's role change reverts only to a role that confers no key the current role lacks,
//   and never to the Platform Administrator role from another; else `not-permitted`;
// - an enabling reverts (the account is disabled again, every session revoked and every challenge
//   voided, as a disable does); restoring `active` is always `not-permitted`.
// A narrowing revert keeps identity's last-holder guard: it never leaves the Market without an
// active, verified Platform Administrator (`LastHolderPolicy`; that role holds every key, the
// role-management and review keys included), else `not-permitted`. The decider's own role-editing
// keys are not asked for (the area's review key, checked by System requests, is the authority).
// Every outcome but `reverted` writes nothing; the request then stays open.

/** The ports the three reverters read and write. */
export interface PeopleReverterDependencies {
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/** The deciding admin; a revert needs one acting as themselves (System requests checks it too). */
function decider(context: CallContext): Id<'Account'> {
  const admin = adminOf(context);
  if (admin === null) {
    throw new Error('identity: a revert needs a signed-in admin acting as themselves');
  }
  return admin;
}

const idOf = <K extends string>(value: unknown): Id<K> | null => {
  if (typeof value !== 'string') return null;
  const parsed = parseId<K>(value);
  return parsed.ok ? parsed.value : null;
};

/** The one role id of `{ roleIds: [id] }` (an admin holds one role in Phase 2), or null. */
const singleRoleId = (values: Readonly<Record<string, unknown>>): Id<'Role'> | null => {
  const ids = values.roleIds;
  return Array.isArray(ids) && ids.length === 1 ? idOf<'Role'>(ids[0]) : null;
};

/** The signed-in admin acting as themselves, or null (System requests refuses any other). */
function adminOf(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'admin' && !isActingAsSession(actor)
    ? actor.accountId
    : null;
}

const sameList = (a: readonly string[], b: unknown): boolean =>
  Array.isArray(b) && a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Restores a custom platform role's name and keys before an edit, while the role still holds the
 * values after it. Gone: the role was deleted (or is no longer a custom platform role), or the
 * values before no longer parse. Changed since: the role differs from `after`, or another role
 * took the name before meanwhile.
 */
export async function revertPlatformRole(
  deps: PeopleReverterDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<RevertOutcome> {
  decider(context);
  const { market } = context;
  const roleId = idOf<'Role'>(request.subjectRef);
  const name = parseRoleName(request.before.name);
  // A key the catalogue no longer declares cannot be restored and confers nothing: drop it rather
  // than leave the request unrevertable (a dropped key only narrows the restored role further).
  const before = request.before.permissionKeys;
  const declaredBefore = Array.isArray(before)
    ? before.filter((key) => typeof key !== 'string' || deps.permissions.get(key) !== undefined)
    : before;
  const keys = parseRoleKeys(declaredBefore, 'platform', deps.permissions);
  if (roleId === null || !name.ok || !keys.ok) return 'gone';
  const role = await deps.roles.findById(market, roleId);
  if (role === null || role.state.scope !== 'platform' || role.state.kind !== 'custom') {
    return 'gone';
  }
  const current = role.state.permissionKeys;
  if (role.state.name !== request.after.name || !sameList(current, request.after.permissionKeys)) {
    return 'changed-since';
  }
  const held = new Set(current);
  // Never widen: a revert that would give the role's holders a key they lack waits for a person.
  if (keys.value.some((key) => !held.has(key))) return 'not-permitted';
  if (
    role.nameNormalized !== normalizeRoleName(name.value) &&
    (await deps.roles.nameTaken(market, 'platform', null, normalizeRoleName(name.value), roleId))
  ) {
    return 'changed-since';
  }
  const isDeclared = (key: string): boolean => deps.permissions.get(key) !== undefined;
  const edit = role.edit({
    name: name.value,
    permissionKeys: keys.value,
    isDeclared,
    now: deps.clock.now(),
  });
  await deps.roles.saveCustom(market, edit);
  await deps.outbox.append(context, edit.role.pendingEvents);
  await deps.audit.record(
    context,
    RoleRevertedAudit.entry(roleId, {
      after: {
        scope: 'platform',
        removedKeys: [...edit.removedKeys],
        renamed: edit.renamed,
        requestId: request.requestId,
      },
    }),
  );
  return 'reverted';
}

/**
 * Restores an admin's role before a change, while the admin still holds the role after it and the
 * role before confers no key the current one lacks. Gone: the account or the role before no
 * longer exists (in this Market's platform scope). Sessions stay, as with any role change:
 * permissions are read on every request (R4).
 */
export async function revertAdminRoles(
  deps: PeopleReverterDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<RevertOutcome> {
  const admin = decider(context);
  const { market } = context;
  const accountId = idOf<'Account'>(request.subjectRef);
  const restoreId = singleRoleId(request.before);
  if (accountId === null || restoreId === null) return 'gone';
  const account = await deps.accounts.findById(market, accountId);
  if (account === null || account.state.population !== 'admin') return 'gone';
  const assignment = await deps.assignments.findByAccount(market, accountId);
  if (assignment === null) return 'gone';
  const currentId = assignment.state.roleId;
  if (currentId !== singleRoleId(request.after)) return 'changed-since';
  const restore = await deps.roles.findById(market, restoreId);
  const current = await deps.roles.findById(market, currentId);
  if (restore === null || restore.state.scope !== 'platform') return 'gone';
  if (current === null) return 'changed-since';
  const systemRoleId = (await deps.roles.findSystemRole(market, 'platform'))?.state.id ?? null;
  const toSystem = isSystemRole(restoreId, systemRoleId);
  const fromSystem = isSystemRole(currentId, systemRoleId);
  // Never widen: not to the system role from another, not to a role with a key the current lacks.
  if (toSystem && !fromSystem) return 'not-permitted';
  const now = grantedRoleOf(current, deps.effectiveKeys).effectiveKeys;
  const then = grantedRoleOf(restore, deps.effectiveKeys).effectiveKeys;
  if ([...then].some((key) => !now.has(key))) return 'not-permitted';
  if (fromSystem && !toSystem) {
    // The last-holder guard of the role change itself (R3, AC 25), counted in this unit.
    const holders = await deps.assignments.activeHoldersOf(market, systemRoleId!);
    if (!LastHolderPolicy.allowsLosing(holders, accountId).ok) return 'not-permitted';
  }
  assignment.reassign({
    account: { id: accountId, marketId: market.marketId, population: 'admin' },
    role: restore,
    assignedBy: admin,
    now: deps.clock.now(),
  });
  await deps.assignments.save(market, assignment);
  await deps.outbox.append(context, assignment.pendingEvents);
  await deps.audit.record(
    context,
    AccountRoleRevertedAudit.entry(accountId, {
      before: { roleId: currentId },
      after: { roleId: restoreId, scope: 'platform', requestId: request.requestId },
    }),
  );
  return 'reverted';
}

/**
 * Disables again an admin whose enabling is rejected or withdrawn, while the admin is still
 * active: the same write as a disable (every session revoked, every open challenge void, HF11),
 * under the account's credential lock, and never the last Platform Administrator who can sign
 * in. Restoring `active` is never done by a revert (`not-permitted`).
 */
export async function revertAdminStatus(
  deps: PeopleReverterDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<RevertOutcome> {
  decider(context);
  const { market } = context;
  const accountId = idOf<'Account'>(request.subjectRef);
  const restore = request.before.status;
  if (accountId === null || (restore !== 'active' && restore !== 'disabled')) return 'gone';
  // The lock the sign-in closing units take before they re-check the status (HF11).
  if (!(await deps.accounts.lockCredential(market, accountId))) return 'gone';
  const account = await deps.accounts.findById(market, accountId);
  if (account === null || account.state.population !== 'admin') return 'gone';
  if (account.state.status !== request.after.status) return 'changed-since';
  // Never widen: a revert never enables an account (a disable opens no request; older ones stay).
  if (restore === 'active') return 'not-permitted';
  const systemRoleId = (await deps.roles.findSystemRole(market, 'platform'))?.state.id ?? null;
  const roleId = (await deps.assignments.findByAccount(market, accountId))?.state.roleId ?? null;
  if (isSystemRole(roleId, systemRoleId)) {
    const holders = await deps.assignments.activeHoldersOf(market, systemRoleId!);
    if (!LastHolderPolicy.allowsLosing(holders, accountId).ok) return 'not-permitted';
  }
  const written = await writeAccountStatus(deps, context, account, 'disabled', deps.clock.now());
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

// Separation of duties (Hassan M1): System requests asks each reverter whether the decider has a
// stake in the change, inside the decision's unit, and refuses approve and reject when so
// (`system-requests.own-subject`). An admin never decides a change to their own account, nor an
// edit of the role they hold now. Any actor that is not a signed-in admin counts as interested
// (fail closed; System requests refuses such an actor before asking).

/** The request is about the deciding admin's own account. */
function isSubject(context: CallContext, subjectRef: string): boolean {
  const admin = adminOf(context);
  return admin === null || admin === subjectRef;
}

/** The deciding admin holds the role `subjectRef` now. */
async function holdsRole(
  deps: PeopleReverterDependencies,
  context: CallContext,
  subjectRef: string,
): Promise<boolean> {
  const admin = adminOf(context);
  if (admin === null) return true;
  const assignment = await deps.assignments.findByAccount(context.market, admin);
  return assignment !== null && assignment.state.roleId === subjectRef;
}

/** `identity.platform-role`: a custom platform role's name and keys. */
export class PlatformRoleReverter implements SystemChangeReverter {
  constructor(private readonly deps: PeopleReverterDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertPlatformRole(this.deps, context, request);
  }

  /** The decider currently holds the role (a change to their own access). */
  async isInterested(context: CallContext, request: RevertRequest): Promise<boolean> {
    return holdsRole(this.deps, context, request.subjectRef);
  }
}

/** `identity.admin-roles`: an admin's role. */
export class AdminRolesReverter implements SystemChangeReverter {
  constructor(private readonly deps: PeopleReverterDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertAdminRoles(this.deps, context, request);
  }

  /** The change is the decider's own role. */
  isInterested(context: CallContext, request: RevertRequest): Promise<boolean> {
    return Promise.resolve(isSubject(context, request.subjectRef));
  }
}

/** `identity.admin-status`: an admin's enabling. */
export class AdminStatusReverter implements SystemChangeReverter {
  constructor(private readonly deps: PeopleReverterDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertAdminStatus(this.deps, context, request);
  }

  /** The change is the decider's own enabling. */
  isInterested(context: CallContext, request: RevertRequest): Promise<boolean> {
    return Promise.resolve(isSubject(context, request.subjectRef));
  }
}
