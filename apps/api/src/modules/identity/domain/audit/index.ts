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
// Slice 6b: the retrofit of slice 5. Later slices add their actions here (PA 5).

/**
 * A system role was created by the seed routine for one hosted Market (identity design 5.6;
 * PA 5 row 1). Target: the role. Written once per role per Market, when the role is created;
 * a run that finds the role creates nothing and writes nothing. No backfill (PA 5).
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
  SellerAccessFounded,
  SellerMemberAdded,
  AccountRoleAssigned,
]);
