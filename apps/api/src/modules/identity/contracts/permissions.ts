import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of identity (identity design 5.3; platform-foundations 6.1), pushed
// into the permission registry at bootstrap (slice 8a-1). Labels are translation keys derived
// from the key. `protected` is R11: a protected key may be put in a role, or a role holding one
// assigned or invited, only by a holder of the system role of that scope; in Phase 2 protected
// seller keys are not grantable at all, so only the Seller Owner manages the team (5.4).
// Non-default verbs (5.1, I9): approve, suspend, disable, invite, remove, assign, assign-role,
// reset-second-factor.

const platform = (key: string, isProtected: boolean) =>
  definePermission('identity', { key, scope: 'platform', protected: isProtected });
const seller = (key: string, isProtected: boolean) =>
  definePermission('identity', { key, scope: 'seller', protected: isProtected });

/** See sellers awaiting a decision, their state and reason. */
export const SELLER_ACCESS_VIEW = platform('identity.seller-access.view', false);
/** Approve and reject (one decision; SEL-03). The key of the reviewer notice (8.7). */
export const SELLER_ACCESS_APPROVE = platform('identity.seller-access.approve', false);
/** Suspend and reinstate (SEL-07). */
export const SELLER_ACCESS_SUSPEND = platform('identity.seller-access.suspend', false);
/** Create a seller by invitation; re-send or revoke that invitation (SEL-06). */
export const SELLER_ACCOUNT_CREATE = platform('identity.seller-account.create', false);
/** Start the reset of a seller-side account's second factor (7.3). */
export const SELLER_ACCOUNT_RESET_SECOND_FACTOR = platform(
  'identity.seller-account.reset-second-factor',
  false,
);
/** Find a customer account by email; see its status. */
export const CUSTOMER_ACCOUNT_VIEW = platform('identity.customer-account.view', false);
/** Disable and re-enable a customer account. */
export const CUSTOMER_ACCOUNT_DISABLE = platform('identity.customer-account.disable', false);
/** List admin accounts, their roles and open invitations. */
export const ADMIN_ACCOUNT_VIEW = platform('identity.admin-account.view', false);
/** Invite an admin; re-send or revoke. */
export const ADMIN_ACCOUNT_INVITE = platform('identity.admin-account.invite', true);
/** Disable and re-enable an admin account. */
export const ADMIN_ACCOUNT_DISABLE = platform('identity.admin-account.disable', true);
/** Reset another admin's second factor. */
export const ADMIN_ACCOUNT_RESET_SECOND_FACTOR = platform(
  'identity.admin-account.reset-second-factor',
  true,
);
/** See roles and their permissions (admin panel). */
export const PLATFORM_ROLE_VIEW = platform('identity.platform-role.view', false);
/** The role editor of the admin panel (decision 8b). */
export const PLATFORM_ROLE_CREATE = platform('identity.platform-role.create', true);
export const PLATFORM_ROLE_EDIT = platform('identity.platform-role.edit', true);
export const PLATFORM_ROLE_DELETE = platform('identity.platform-role.delete', true);
/** Change an admin's role. */
export const PLATFORM_ROLE_ASSIGN = platform('identity.platform-role.assign', true);

/** See the team, roles of members, open invitations; `membershipOf` for other accounts (8.1). */
export const TEAM_MEMBER_VIEW = seller('identity.team-member.view', false);
/** Team management (PNL-05). */
export const TEAM_MEMBER_INVITE = seller('identity.team-member.invite', true);
export const TEAM_MEMBER_REMOVE = seller('identity.team-member.remove', true);
export const TEAM_MEMBER_ASSIGN_ROLE = seller('identity.team-member.assign-role', true);
export const TEAM_MEMBER_RESET_SECOND_FACTOR = seller(
  'identity.team-member.reset-second-factor',
  true,
);
/** See roles and their permissions (seller panel). */
export const SELLER_ROLE_VIEW = seller('identity.seller-role.view', false);
/** The role editor of the seller panel (decision 8). */
export const SELLER_ROLE_CREATE = seller('identity.seller-role.create', true);
export const SELLER_ROLE_EDIT = seller('identity.seller-role.edit', true);
export const SELLER_ROLE_DELETE = seller('identity.seller-role.delete', true);

/** Every permission identity declares, for its module's registration. */
export const IDENTITY_PERMISSIONS = declarePermissions('identity', [
  SELLER_ACCESS_VIEW,
  SELLER_ACCESS_APPROVE,
  SELLER_ACCESS_SUSPEND,
  SELLER_ACCOUNT_CREATE,
  SELLER_ACCOUNT_RESET_SECOND_FACTOR,
  CUSTOMER_ACCOUNT_VIEW,
  CUSTOMER_ACCOUNT_DISABLE,
  ADMIN_ACCOUNT_VIEW,
  ADMIN_ACCOUNT_INVITE,
  ADMIN_ACCOUNT_DISABLE,
  ADMIN_ACCOUNT_RESET_SECOND_FACTOR,
  PLATFORM_ROLE_VIEW,
  PLATFORM_ROLE_CREATE,
  PLATFORM_ROLE_EDIT,
  PLATFORM_ROLE_DELETE,
  PLATFORM_ROLE_ASSIGN,
  TEAM_MEMBER_VIEW,
  TEAM_MEMBER_INVITE,
  TEAM_MEMBER_REMOVE,
  TEAM_MEMBER_ASSIGN_ROLE,
  TEAM_MEMBER_RESET_SECOND_FACTOR,
  SELLER_ROLE_VIEW,
  SELLER_ROLE_CREATE,
  SELLER_ROLE_EDIT,
  SELLER_ROLE_DELETE,
]);
