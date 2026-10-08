import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Role, RoleAssignment, RoleScope } from '../../domain/role';
import type { SellerMembership } from '../../domain/seller-membership';

/**
 * The memberships of `identity` (identity design 2.1, 2.3; data design 3.9). Every method runs in
 * the caller's open unit and takes the `MarketContext` only.
 */
export interface SellerMembershipRepository {
  /** The active membership of this account (at most one in Phase 2), or null. */
  findActiveByAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<SellerMembership | null>;

  /** Every membership of this account, active or removed (the unverified purge). */
  findAllByAccount(market: MarketContext, accountId: Id<'Account'>): Promise<SellerMembership[]>;

  /** Whether the seller has a membership of any state (HF5 "never had a member"; the purge). */
  sellerHasMembers(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean>;

  add(market: MarketContext, membership: SellerMembership): Promise<void>;

  /** Deletes a membership with the version read (the unverified purge); else stale. */
  remove(market: MarketContext, membership: SellerMembership): Promise<void>;
}

/**
 * Roles (identity design 2.1, 5.6; data design 3.9). Slice 5 reads and seeds the system roles.
 */
export interface RoleRepository {
  /** The system role of this scope in this Market, or null when the seed has not run. */
  findSystemRole(market: MarketContext, scope: RoleScope): Promise<Role | null>;

  /** The role with this id, or null. */
  findById(market: MarketContext, id: Id<'Role'>): Promise<Role | null>;

  /**
   * Stores a seeded role unless a role with its scope and seed code exists; answers whether it
   * stored it. A concurrent seed run converges (data design 8.3): the loser stores nothing.
   */
  addSeeded(market: MarketContext, role: Role): Promise<boolean>;
}

/** The role assignments (identity design 2.1, 2.3; data design 3.9). */
export interface RoleAssignmentRepository {
  /** The one assignment of this account in Phase 2, or null. */
  findByAccount(market: MarketContext, accountId: Id<'Account'>): Promise<RoleAssignment | null>;

  add(market: MarketContext, assignment: RoleAssignment): Promise<void>;

  /** Deletes an assignment with the version read (the unverified purge); else stale. */
  remove(market: MarketContext, assignment: RoleAssignment): Promise<void>;
}

/** Nest tokens. */
export const SELLER_MEMBERSHIP_REPOSITORY = Symbol('SELLER_MEMBERSHIP_REPOSITORY');
export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');
export const ROLE_ASSIGNMENT_REPOSITORY = Symbol('ROLE_ASSIGNMENT_REPOSITORY');
