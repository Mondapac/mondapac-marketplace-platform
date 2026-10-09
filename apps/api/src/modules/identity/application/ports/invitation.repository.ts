import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Invitation, InvitationKind } from '../../domain/invitation';

/**
 * A pending admin invitation as the admin team list reads it (slice 8c): no token hash, no
 * decision fields. The invited address is personal data, never logged.
 */
export interface PendingAdminInvitation {
  readonly id: Id<'Invitation'>;
  readonly state: 'pending';
  /** As typed. */
  readonly email: string;
  readonly roleId: Id<'Role'>;
  readonly invitedByAccountId: Id<'Account'> | null;
  readonly expiresAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
}

/**
 * The invitations of `identity` (identity design 3.4; data design 3.10). Every method runs in
 * the caller's open unit and takes the `MarketContext` only. A token is never passed in, only
 * its SHA-256. The invited address is personal data: it is never logged here.
 */
export interface InvitationRepository {
  findById(market: MarketContext, id: Id<'Invitation'>): Promise<Invitation | null>;

  /** The invitation whose stored hash is this one, in this Market, or null. */
  findByTokenHash(market: MarketContext, tokenHash: Uint8Array): Promise<Invitation | null>;

  /**
   * The pending invitation for this address in this scope (a seller, or the platform when
   * `sellerId` is null), or null: the row the partial unique keys of data design 8.4 allow at
   * most one of. An issue reads it to replace it when stale (M7; item G).
   */
  findPendingFor(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
    emailNormalized: string,
  ): Promise<Invitation | null>;

  /**
   * The pending seller-owner invitation of this seller, or null: at most one, by the partial
   * unique key `invitations_market_id_seller_id_owner_pending_key` (HF5 (a), M12; slice 9).
   */
  findPendingOwnerInvitation(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<Invitation | null>;

  /**
   * The pending seller-owner invitation for this normalised address in this Market, whatever the
   * seller, or null: at most one, by the partial unique key
   * `invitations_market_id_email_seller_owner_pending_key` (3.10; Mojtaba Q5 on PR #204).
   */
  findPendingOwnerInvitationByEmail(
    market: MarketContext,
    emailNormalized: string,
  ): Promise<Invitation | null>;

  /**
   * Up to `limit` pending admin invitations of this Market (platform scope, `seller_id` NULL),
   * expired ones included, whose id is greater than `after` (all when null), by id: the open
   * invitations of the admin team list (slice 8c), as a summary without the token hash (Hassan
   * L1 on PR #196). Served by the partial index `invitations_market_id_email_pending_platform_key`.
   */
  pendingAdminInvitations(
    market: MarketContext,
    after: Id<'Invitation'> | null,
    limit: number,
  ): Promise<PendingAdminInvitation[]>;

  /**
   * Stores a new invitation. A pending invitation for the same address and scope, or a second
   * pending seller-owner invitation for the seller (the partial unique indexes of data design
   * 3.10, M12), throws {@link InvitationAlreadyPendingError}.
   */
  add(market: MarketContext, invitation: Invitation): Promise<void>;

  /**
   * Stores the changes of a loaded invitation if its version is still the one read; otherwise
   * throws `StaleAggregateError` (platform persistence 10).
   */
  save(market: MarketContext, invitation: Invitation): Promise<void>;

  /**
   * The hourly purge (data design 9): pending invitations whose expiry is before `now`, decided
   * ones whose decision is before `decidedBefore`, and (Ali 2026-10-08) pending invitations never
   * dispatched (no token) created before the cut-off given for their kind, which is `now` minus
   * that kind's lifetime. A kind with no cut-off is left alone. Answers how many were deleted.
   */
  purge(
    market: MarketContext,
    now: Temporal.Instant,
    decidedBefore: Temporal.Instant,
    undispatchedCreatedBefore?: Readonly<Partial<Record<InvitationKind, Temporal.Instant>>>,
  ): Promise<number>;
}

/** Nest token of the {@link InvitationRepository}. */
export const INVITATION_REPOSITORY = Symbol('INVITATION_REPOSITORY');

/** One pending invitation per address and scope, one pending owner per seller (3.4, M12). */
export class InvitationAlreadyPendingError extends Error {
  override readonly name = 'InvitationAlreadyPendingError';
  readonly code = 'invitation.already-pending';
  constructor() {
    super('identity: an invitation for this address and scope is already pending');
  }
}
