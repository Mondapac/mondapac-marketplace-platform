import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Role, RoleAssignment, RoleScope, SeedUpgrade } from '../../domain/role';
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
 * Roles (identity design 2.1, 5.6; data design 3.9). Slice 5 reads and seeds the system roles;
 * slice 8a-1 the default roles, their stored keys (`role_permissions`) and seed upgrades. Every
 * role read loads its stored keys.
 */
export interface RoleRepository {
  /** The system role of this scope in this Market, or null when the seed has not run. */
  findSystemRole(market: MarketContext, scope: RoleScope): Promise<Role | null>;

  /** The role with this id, or null. */
  findById(market: MarketContext, id: Id<'Role'>): Promise<Role | null>;

  /** The seeded role of this scope and seed code (the seed routine's key, 8.3), or null. */
  findBySeedCode(market: MarketContext, scope: RoleScope, seedCode: string): Promise<Role | null>;

  /**
   * Stores a seeded role, with its stored keys, unless a role with its scope and seed code (or
   * a second system role of the scope) exists; answers whether it stored it. A concurrent seed
   * run converges (data design 8.3): the loser stores nothing.
   */
  addSeeded(market: MarketContext, role: Role): Promise<boolean>;

  /**
   * Stores a seed upgrade (5.6): the role's `seed_version` and version at the version read
   * (else `StaleAggregateError`, so a concurrent run converges), then the added key rows
   * and the removed ones, key by key (`role_permissions` rows are never updated).
   */
  applySeed(market: MarketContext, upgrade: SeedUpgrade): Promise<void>;
}

/** The role assignments (identity design 2.1, 2.3; data design 3.9). */
export interface RoleAssignmentRepository {
  /** The one assignment of this account in Phase 2, or null. */
  findByAccount(market: MarketContext, accountId: Id<'Account'>): Promise<RoleAssignment | null>;

  add(market: MarketContext, assignment: RoleAssignment): Promise<void>;

  /**
   * Whether this role has a holder that can sign in: an active account with a verified email
   * (identity design 5.5, R3 "can sign in"; HF5 (b): an admin invitation without an inviter is
   * refused once the Market has an active Platform Administrator). One read on the
   * `(market_id, role_id)` index with a filter on the account.
   */
  hasActiveHolder(market: MarketContext, roleId: Id<'Role'>): Promise<boolean>;

  /**
   * The holders of this role that can sign in, as account ids: active, with a verified email
   * (identity design 5.5, `LastHolderPolicy`; slice 8a-2). The read of {@link hasActiveHolder},
   * returning every id; run in the caller's serializable unit (HF8), so a concurrent change of
   * any holder it read makes one of the two units retry.
   */
  activeHoldersOf(market: MarketContext, roleId: Id<'Role'>): Promise<Id<'Account'>[]>;

  /**
   * Stores a changed assignment (a new role, slice 8a-2) if its version is still the one read;
   * otherwise throws `StaleAggregateError` (platform persistence 10).
   */
  save(market: MarketContext, assignment: RoleAssignment): Promise<void>;

  /** Deletes an assignment with the version read (the unverified purge); else stale. */
  remove(market: MarketContext, assignment: RoleAssignment): Promise<void>;
}

/** Nest tokens. */
export const SELLER_MEMBERSHIP_REPOSITORY = Symbol('SELLER_MEMBERSHIP_REPOSITORY');
export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');
export const ROLE_ASSIGNMENT_REPOSITORY = Symbol('ROLE_ASSIGNMENT_REPOSITORY');
