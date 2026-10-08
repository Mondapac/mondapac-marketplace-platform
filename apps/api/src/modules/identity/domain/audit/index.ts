import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { AuditActionDefinition } from '@mondapac/shared-kernel';
import { SELLER_ACCESS_STATES, SELLER_ORIGINS } from '../events';
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
 * Market that is behind jumps over (it goes straight to the file's version). Permission keys are
 * at most `MAX_PERMISSION_KEY_LENGTH` (45) characters, so the worst case, 40 added and 40 removed
 * at that length, fits the writer's 4 KB per side (PA W4; tested in
 * test/contracts/role-seed.contract.spec.ts).
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

/** The founding assignment of the seller's system role (see {@link SellerAccessFounded}). */
export const AccountRoleAssigned = defineAuditAction({
  action: 'identity.account-role.assigned',
  targetType: 'identity.account',
  actors: ['anonymous'],
  after: {
    sellerId: auditField.id(),
    accountId: auditField.id(),
    boundSubjectId: auditField.id(),
    roleId: auditField.id(),
    scope: auditField.enumOf(ROLE_SCOPES),
    founding: auditField.boolean(),
  },
});

/** Every audited action of identity, for its module's registration. */
export const IDENTITY_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  RoleSeeded,
  RoleSeedApplied,
  SellerAccessFounded,
  SellerMemberAdded,
  AccountRoleAssigned,
]);
