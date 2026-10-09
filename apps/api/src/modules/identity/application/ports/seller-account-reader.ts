import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { SellerAccessStateCode, SellerOrigin } from '../../domain/seller-access';

/**
 * The Seller Owner of a seller as the admin seller list and `sellerAccountSummaries` show it
 * (identity design 8.1, 8.6 row 8; slice 9b). The address and the name are personal data: only
 * for an admin holding `identity.seller-access.view`, never in a log, an event or an audit row.
 */
export interface SellerOwnerSummary {
  readonly accountId: Id<'Account'>;
  /** As typed. */
  readonly email: string;
  readonly displayName: string | null;
  readonly emailVerified: boolean;
}

/** A registered seller and its owner (null while it has none: an invitation not yet accepted). */
export interface SellerAccountRecord {
  readonly sellerId: Id<'Seller'>;
  readonly origin: SellerOrigin;
  readonly state: SellerAccessStateCode;
  readonly stateChangedAt: Temporal.Instant;
  readonly reapplyCount: number;
  readonly owner: SellerOwnerSummary | null;
}

/** A pending seller-owner invitation, as the list reads it: no token hash, no decision fields. */
export interface OpenSellerOwnerInvitation {
  readonly id: Id<'Invitation'>;
  readonly sellerId: Id<'Seller'>;
  readonly state: 'pending';
  /** As typed; personal. */
  readonly email: string;
  /** The name the admin gave (`ux.md` D6); personal. */
  readonly displayName: string | null;
  readonly invitedByAccountId: Id<'Account'> | null;
  readonly expiresAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
}

/** What the list's seller read selects (each field is optional; all apply together). */
export interface OwnedSellerQuery {
  /** One access state, or every state. */
  readonly state: SellerAccessStateCode | null;
  /** Only these sellers (the exact-email search); null for no restriction. */
  readonly sellerIds: readonly Id<'Seller'>[] | null;
  /** Only sellers whose owner is this account (the exact-email search); null for any owner. */
  readonly ownerAccountId: Id<'Account'> | null;
  /** The last seller id of the previous page; null for the first page. */
  readonly after: Id<'Seller'> | null;
  readonly limit: number;
}

/**
 * The SQL reads of the admin seller list and `sellerAccountSummaries` (identity design 8.1, 8.6
 * row 8; slice 9b), on `identity`'s own tables only: `seller_access`, `seller_memberships`,
 * `role_assignments`, `roles`, `accounts` and `invitations`. Nothing of `sellers` is read (no
 * join into another module's schema). Every statement has `market_id` in its predicate (Mojtaba);
 * each method runs in the caller's open unit, read-only, and takes the `MarketContext` only.
 *
 * The Seller Owner is the account of an active membership of the seller whose assignment is the
 * system role of the seller scope, in the seller population: the rule of `readSellerPeople`.
 */
export interface SellerAccountReader {
  /**
   * Up to `limit` registered sellers (`registered_at` set) whose owner has a verified email
   * ("sellers whose owner confirmed the email", 8.6 row 8), by seller id, with the owner.
   */
  ownedSellers(market: MarketContext, query: OwnedSellerQuery): Promise<SellerAccountRecord[]>;

  /**
   * The registered sellers among these ids, in no particular order, each with its owner or
   * null (8.1 `sellerAccountSummaries`): an unknown id, another Market's and an unregistered
   * seller are absent. The caller bounds the list.
   */
  summariesOf(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<SellerAccountRecord[]>;

  /**
   * The seller account with this normalised address and the sellers of its active memberships
   * (the exact-email search, 11.2): the account by the `(market_id, population,
   * email_normalized)` key, then its memberships by `(market_id, account_id)`. At most one seller
   * in Phase 2 (one membership per account). Null when no seller account has the address. The
   * caller keeps only the sellers it owns (`ownerAccountId`), so a staff member's address finds
   * nothing.
   */
  sellersOfAddress(
    market: MarketContext,
    emailNormalized: string,
  ): Promise<{ readonly accountId: Id<'Account'>; readonly sellerIds: Id<'Seller'>[] } | null>;

  /**
   * Up to `limit` pending seller-owner invitations of this Market (expired ones included), whose
   * id is greater than `after` (all when null) and, when given, whose normalised address is
   * `emailNormalized`, by id: the open seller invitations of the list (8.6 row 8).
   */
  openOwnerInvitations(
    market: MarketContext,
    query: {
      readonly emailNormalized: string | null;
      readonly after: Id<'Invitation'> | null;
      readonly limit: number;
    },
  ): Promise<OpenSellerOwnerInvitation[]>;
}

/** Nest token of the {@link SellerAccountReader}. */
export const SELLER_ACCOUNT_READER = Symbol('SELLER_ACCOUNT_READER');
