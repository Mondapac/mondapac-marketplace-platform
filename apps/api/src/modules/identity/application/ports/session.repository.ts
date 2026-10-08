import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Session, SessionRevokedReason } from '../../domain/session';
import type { SellerAccessStateCode } from '../../domain/seller-access';

/** What the `Authenticator` reads per request, in one call (identity design 6.2). */
export interface SessionForAuthentication {
  readonly session: Session;
  readonly accountStatus: 'active' | 'disabled';
  /**
   * For a seller session (slice 5), read in the same call: the seller of the account's active
   * membership (null when it has none), and the access state of the session's seller (null
   * when it has none). Both null for every other population.
   */
  readonly activeMembershipSellerId: Id<'Seller'> | null;
  readonly sellerAccessState: SellerAccessStateCode | null;
}

/**
 * The sessions of `identity` (identity design 3.5, 6.2; data design 3.4). Every method runs in
 * the caller's open unit (read-only where it only reads) and takes the `MarketContext` only;
 * the Market and tenant of every row come from it. The token itself never reaches this port:
 * only its SHA-256.
 */
export interface SessionRepository {
  /** Stores a new session with the hash of its token. */
  add(market: MarketContext, session: Session, tokenHash: Uint8Array): Promise<void>;

  /** The session with this token hash and the status of its account, or null. */
  findForAuthentication(
    market: MarketContext,
    tokenHash: Uint8Array,
  ): Promise<SessionForAuthentication | null>;

  /** The session with this id, or null. */
  findById(market: MarketContext, id: Id<'Session'>): Promise<Session | null>;

  /**
   * Writes `lastSeenAt = now` when it is older than `lastSeenBefore` and the session is not
   * revoked; a no-op otherwise (at most once a minute, identity design 6.1).
   */
  touch(
    market: MarketContext,
    id: Id<'Session'>,
    now: Temporal.Instant,
    lastSeenBefore: Temporal.Instant,
  ): Promise<void>;

  /**
   * Revokes this account's session if it is not revoked yet (a set-based update that never
   * loses against `touch`). Answers whether a row changed.
   */
  revoke(
    market: MarketContext,
    id: Id<'Session'>,
    accountId: Id<'Account'>,
    reason: SessionRevokedReason,
    now: Temporal.Instant,
  ): Promise<boolean>;

  /** Deletes sessions whose absolute expiry is before `expiredBefore`; answers how many. */
  purgeExpired(market: MarketContext, expiredBefore: Temporal.Instant): Promise<number>;
}

/** Nest token of the {@link SessionRepository}. */
export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');
