import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { AuditActionDefinition, AuditEntry, Id } from '@mondapac/shared-kernel';
import { INVITATION_KINDS, SELLER_ACCESS_STATES, SELLER_ORIGINS } from '../events';
import { ROLE_KINDS, ROLE_SCOPES } from '../role';

// The audited actions of identity (docs/design/domain/platform-audit.md 5; identity design
// 10.1), registered at boot with `registerAuditActions('identity', IDENTITY_AUDIT_ACTIONS)`
// and written through identity's own AUDIT_WRITER in the unit of the change. Ids, codes and
// flags only: never an email, a name, a role name or a reason (R5, VER-13, AC 12). Every new or
// changed action changes the checked-in catalogue snapshot, for the security review.
//
// Slice 6b: the retrofit of slice 5. Slice 8a-1: the seed-version upgrade. Later slices add
// their actions here (PA 5).

/**
 * A system or (slice 8a-1) default role was created by the seed routine for one hosted Market
 * (identity design 5.6; PA 5 row 1). Target: the role. Written once per role per Market, when
 * the role is created; a run that finds the role creates nothing and writes nothing. No backfill
 * (PA 5). A default role's keys are those of its seed file at `seedVersion` (a change raises the
 * version), so the row names them by version: the append-only test/contracts/role-seed.snapshot.json
 * keeps the keys of every version that shipped (Mohammad 2, Hassan M-1). A later change is
 * `identity.role.seed-applied`.
 */
export const RoleSeeded = defineAuditAction({
  action: 'identity.role.seeded',
  targetType: 'identity.role',
  actors: ['system'],
  after: {
    scope: auditField.enumOf(ROLE_SCOPES),
    kind: auditField.enumOf(ROLE_KINDS),
    seedVersion: auditField.integer(),
  },
});

/**
 * Most keys one seeded role may hold, and so most keys one `identity.role.seed-applied` row lists
 * as added, and as removed. `checkRoleSeed` and `checkRoleSeedKeys` refuse a seed role with more,
 * at boot and on every run (Mohammad 3, Hassan L-1). Since every version of a role holds at most
 * this many keys, an upgrade adds at most 40 and removes at most 40, however many versions a
 * Market that is behind jumps over (it goes straight to the file's version). The bytes are
 * bounded separately: a seeded role's keys must also fit the byte budget of
 * `application/roles/role-seed-budget.ts`, measured from this action's own encoding, so the
 * worst row fits the writer's 4 KB per side (PA W4; tested in
 * test/contracts/role-seed.contract.spec.ts). "Removed" is a subset of a previous version that
 * passed the same budget; if the budget formula changes, older snapshot entries are re-checked.
 */
export const MAX_SEED_KEYS_PER_ROW = 40;

/**
 * A newer seed version applied to a stored system or default role (identity design 5.6; PA 5
 * row 8a-1; Ali 2026-10-08: "compare seed_version, then an audited update", never
 * `ON CONFLICT DO NOTHING`). Target: the role. Written in the unit of the update, one row per
 * role per upgrade; an equal or older stored version writes nothing. The keys are permission
 * keys known to the registry or its retired list (W4); never the role's name (R5).
 */
export const RoleSeedApplied = defineAuditAction({
  action: 'identity.role.seed-applied',
  targetType: 'identity.role',
  actors: ['system'],
  before: {
    seedVersion: auditField.integer(),
  },
  after: {
    seedVersion: auditField.integer(),
    addedKeys: auditField.listOf(auditField.permissionKey(), MAX_SEED_KEYS_PER_ROW),
    removedKeys: auditField.listOf(auditField.permissionKey(), MAX_SEED_KEYS_PER_ROW),
  },
});

/**
 * The founding rows of a self-registered seller (identity design 5.5; PA 5 row 2, Q1 decided
 * by Ali 2026-10-08): written when the Seller Owner verifies the email, the moment the
 * membership and the assignment take effect, in the unit that records `seller-registered`.
 * The actor is `ANONYMOUS`: the link and the password bind the account, named in
 * `boundSubjectId` (W4a). Each row names `sellerId` and `accountId`, so the founding can be
 * followed from the row alone. Not a grant under R3: the creation of the scope.
 */
export const SellerAccessFounded = defineAuditAction({
  action: 'identity.seller-access.founded',
  targetType: 'identity.seller-access',
  actors: ['anonymous'],
  after: {
    sellerId: auditField.id(),
    accountId: auditField.id(),
    boundSubjectId: auditField.id(),
    state: auditField.enumOf(SELLER_ACCESS_STATES),
    origin: auditField.enumOf(SELLER_ORIGINS),
  },
});

/** The founding membership of the Seller Owner (see {@link SellerAccessFounded}). */
export const SellerMemberAdded = defineAuditAction({
  action: 'identity.seller-member.added',
  targetType: 'identity.seller-access',
  actors: ['anonymous'],
  after: {
    sellerId: auditField.id(),
    accountId: auditField.id(),
    boundSubjectId: auditField.id(),
    roleId: auditField.id(),
    founding: auditField.boolean(),
  },
});

/**
 * A role assigned to an account (identity design 5.3; PA 5 rows 6b, 7, 8a-2, 11). Target: the
 * account. `sellerId` names the seller of a seller-scope assignment and is null for a
 * platform-scope one (an admin's role, slice 7; Mohammad, 6b review 11): build the entry with
 * {@link accountRoleAssigned}, which refuses any other pairing. The founding assignment of a
 * self-registered seller (see {@link SellerAccessFounded}) is the first writer; an admin
 * invitation's acceptance (slice 7b) is the second.
 */
export const AccountRoleAssigned = defineAuditAction({
  action: 'identity.account-role.assigned',
  targetType: 'identity.account',
  actors: ['anonymous'],
  after: {
    sellerId: auditField.optional(auditField.id()),
    accountId: auditField.id(),
    boundSubjectId: auditField.id(),
    roleId: auditField.id(),
    scope: auditField.enumOf(ROLE_SCOPES),
    founding: auditField.boolean(),
  },
});

/** The `after` side of {@link AccountRoleAssigned}. */
export type AccountRoleAssignedAfter = Parameters<typeof AccountRoleAssigned.entry>[1]['after'];

/** An assignment whose `sellerId` does not match its scope: a programming error, never data. */
export class AccountRoleAssignedScopeError extends Error {
  override readonly name = 'AccountRoleAssignedScopeError';
  constructor() {
    super('identity.account-role.assigned: sellerId is required for, and only for, seller scope');
  }
}

/**
 * The only way to build an {@link AccountRoleAssigned} entry: a seller-scope assignment names its
 * seller, a platform-scope one names none (the seller-scope rule of the slice 7 reshape).
 */
export function accountRoleAssigned(
  accountId: Id<'Account'>,
  after: AccountRoleAssignedAfter,
): AuditEntry {
  if ((after.scope === 'seller') !== (after.sellerId !== null)) {
    throw new AccountRoleAssignedScopeError();
  }
  return AccountRoleAssigned.entry(accountId, { after });
}

/** The states a second factor can be in when it is reset (3.6): `none` is no row. */
const FACTOR_STATES = ['pending', 'active'] as const;

/**
 * Another account changed an account's role (identity design 5.5; PA 5 row 8a-2; slice 8a-2 for
 * admins, 11 for Staff). Target: the account. The actor is the signed-in admin who assigned it;
 * `before` and `after` are the role ids, never a role's name (R5).
 *
 * PA 5 names this row `identity.account-role.assigned`, but that action is open to `ANONYMOUS`
 * (the founding rows and an acceptance), and an action open to `ANONYMOUS` must declare a bound
 * subject on every row (W4a); an authenticated change has none. So the change by another account
 * is its own action, named like its event `identity.account-role-changed.v1` (for review).
 */
export const AccountRoleChangedAudit = defineAuditAction({
  action: 'identity.account-role.changed',
  targetType: 'identity.account',
  actors: ['authenticated'],
  before: { roleId: auditField.id() },
  after: {
    roleId: auditField.id(),
    scope: auditField.enumOf(ROLE_SCOPES),
  },
});

/** The account statuses (identity design 3.1), as an audit row names them. */
const ACCOUNT_STATUSES = ['active', 'disabled'] as const;

/** The populations this path disables (3.1): never a seller-side account. */
const DISABLEABLE_POPULATIONS = ['admin', 'customer'] as const;

/**
 * An admin disabled an admin or a customer account (identity design 3.1; PA 5 row 8b). Target:
 * the account. In the same unit every session of the account was revoked and its open challenges
 * voided. State codes only.
 */
export const AccountDisabledAudit = defineAuditAction({
  action: 'identity.account.disabled',
  targetType: 'identity.account',
  actors: ['authenticated'],
  before: { status: auditField.enumOf(ACCOUNT_STATUSES) },
  after: {
    status: auditField.enumOf(ACCOUNT_STATUSES),
    population: auditField.enumOf(DISABLEABLE_POPULATIONS),
  },
});

/** An admin enabled a disabled admin or customer account again (3.1; PA 5 row 8b). */
export const AccountEnabledAudit = defineAuditAction({
  action: 'identity.account.enabled',
  targetType: 'identity.account',
  actors: ['authenticated'],
  before: { status: auditField.enumOf(ACCOUNT_STATUSES) },
  after: {
    status: auditField.enumOf(ACCOUNT_STATUSES),
    population: auditField.enumOf(DISABLEABLE_POPULATIONS),
  },
});

/**
 * An invitation was issued (identity design 3.4, 7.4; PA 5 rows 7 and 8b). Target: the
 * invitation. The first-admin operator routine issues one as `SYSTEM`, its accountability the
 * operator log written before it acts (PA 9.2, Hassan L6), linked by the correlation id; from
 * slice 8b a signed-in admin with `identity.admin-account.invite` issues one as itself, the
 * inviter. Never the invited address (R5).
 */
export const InvitationIssuedAudit = defineAuditAction({
  action: 'identity.invitation.issued',
  targetType: 'identity.invitation',
  actors: ['authenticated', 'system'],
  after: {
    kind: auditField.enumOf(INVITATION_KINDS),
    roleId: auditField.id(),
  },
});

/**
 * A pending invitation was sent again with a new token, the old one void (identity design 3.4;
 * PA 5 row 8b). Target: the invitation.
 */
export const InvitationReissuedAudit = defineAuditAction({
  action: 'identity.invitation.reissued',
  targetType: 'identity.invitation',
  actors: ['authenticated'],
  after: {
    kind: auditField.enumOf(INVITATION_KINDS),
    roleId: auditField.id(),
  },
});

/**
 * A pending invitation was revoked by the inviter's side, or replaced by a new issue for the same
 * address (identity design 3.4; PA 5 row 8b). Target: the invitation.
 */
export const InvitationRevokedAudit = defineAuditAction({
  action: 'identity.invitation.revoked',
  targetType: 'identity.invitation',
  actors: ['authenticated'],
  after: {
    kind: auditField.enumOf(INVITATION_KINDS),
    roleId: auditField.id(),
  },
});

/**
 * An invitation was accepted (identity design 3.4; PA 5 row 7). Target: the invitation. The
 * actor is `ANONYMOUS`: the invitation's token binds the request, so `boundSubjectId` names the
 * invitation (W4a); `accountId` is the account created by it.
 */
export const InvitationAcceptedAudit = defineAuditAction({
  action: 'identity.invitation.accepted',
  targetType: 'identity.invitation',
  actors: ['anonymous'],
  after: {
    kind: auditField.enumOf(INVITATION_KINDS),
    roleId: auditField.id(),
    accountId: auditField.id(),
    boundSubjectId: auditField.id(),
  },
});

/**
 * A second factor became active (identity design 3.4, 3.6; PA 5 row 7): inside an admin
 * invitation's acceptance (`boundSubjectId` = the invitation) or from an enrolment link with the
 * password (`boundSubjectId` = the account). Target: the factor.
 */
export const SecondFactorActivatedAudit = defineAuditAction({
  action: 'identity.second-factor.activated',
  targetType: 'identity.second-factor',
  actors: ['anonymous'],
  after: {
    accountId: auditField.id(),
    boundSubjectId: auditField.id(),
  },
});

/**
 * A new device replaced the admin's factor (identity design 3.6, M13; PA 5 row 7). Target: the
 * factor. The signed-in holder acted.
 */
export const SecondFactorReplacedAudit = defineAuditAction({
  action: 'identity.second-factor.replaced',
  targetType: 'identity.second-factor',
  actors: ['authenticated'],
  after: { accountId: auditField.id() },
});

/** The holder regenerated the recovery codes; the old ones stopped working (3.6; PA 5 row 7). */
export const RecoveryCodesRegeneratedAudit = defineAuditAction({
  action: 'identity.second-factor.recovery-codes-regenerated',
  targetType: 'identity.second-factor',
  actors: ['authenticated'],
  after: { accountId: auditField.id() },
});

/**
 * A second factor was reset to `none` (identity design 3.6, 7.3, 7.4; PA 5 rows 7 and 8b).
 * Target: the removed factor. The operator's break-glass routine resets one as `SYSTEM`, after
 * the operator log (PA 9.2); from slice 8b an admin with
 * `identity.admin-account.reset-second-factor` resets another admin's as itself.
 */
export const SecondFactorResetAudit = defineAuditAction({
  action: 'identity.second-factor.reset',
  targetType: 'identity.second-factor',
  actors: ['authenticated', 'system'],
  before: { state: auditField.enumOf(FACTOR_STATES) },
  after: { accountId: auditField.id() },
});

/**
 * A successful admin sign-in (identity design 10.2; PA 5 row 7): bounded volume, no personal
 * data. Target: the account. `ANONYMOUS`: the password and the factor bound the account, named
 * in `boundSubjectId`; every attempt is also a sign-in record.
 */
export const AdminSessionOpenedAudit = defineAuditAction({
  action: 'identity.admin-session.opened',
  targetType: 'identity.account',
  actors: ['anonymous'],
  after: {
    sessionId: auditField.id(),
    boundSubjectId: auditField.id(),
  },
});

/** Every audited action of identity, for its module's registration. */
export const IDENTITY_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  RoleSeeded,
  RoleSeedApplied,
  SellerAccessFounded,
  SellerMemberAdded,
  AccountRoleAssigned,
  AccountRoleChangedAudit,
  AccountDisabledAudit,
  AccountEnabledAudit,
  InvitationIssuedAudit,
  InvitationReissuedAudit,
  InvitationRevokedAudit,
  InvitationAcceptedAudit,
  SecondFactorActivatedAudit,
  SecondFactorReplacedAudit,
  RecoveryCodesRegeneratedAudit,
  SecondFactorResetAudit,
  AdminSessionOpenedAudit,
]);
