import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AccessDecision, AccessDecisionKind } from '../../domain/access-decision';

/**
 * A stored decision as it is read back (identity design 3.3; data design 3.11). The reason is
 * decrypted under the seller's subject key; once that key is destroyed (erasure) the row stays
 * and the reason is gone: `reason` null and `reasonErased` true. A decision without a reason
 * (approved, reinstated) has `reason` null and `reasonErased` false.
 */
export interface StoredAccessDecision {
  readonly id: Id<'AccessDecision'>;
  readonly sellerId: Id<'Seller'>;
  readonly decision: AccessDecisionKind;
  readonly reason: string | null;
  readonly reasonErased: boolean;
  readonly basisId: Id | null;
  readonly decidedByAccountId: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant;
}

/** The seller's key is destroyed, so a new reason cannot be sealed: never stored in clear. */
export class AccessReasonKeyUnavailableError extends Error {
  override readonly name = 'AccessReasonKeyUnavailableError';
  constructor() {
    super("identity.access_decisions: the seller's subject key is destroyed");
  }
}

/**
 * The decisions on sellers' access (identity design 2.1, 3.3; data design 3.11; slice 9).
 * Append-only: insert and read, nothing else (the table's privileges are `INSERT` and `SELECT`).
 * Every method runs in the caller's unit and takes the `MarketContext` only. The reason is sealed
 * and opened under the **seller's** subject key with the label `identity.access-decision.reason`,
 * so it never leaves this adapter in clear except to the caller that asked for it.
 */
export interface AccessDecisionRepository {
  /**
   * Stores a new decision, its reason encrypted. Throws {@link AccessReasonKeyUnavailableError}
   * when the seller's key is destroyed, which rolls the deciding unit back.
   */
  add(market: MarketContext, decision: AccessDecision): Promise<void>;

  /** The decision with this id, or null (another Market's is null). */
  findById(market: MarketContext, id: Id<'AccessDecision'>): Promise<StoredAccessDecision | null>;

  /** The seller's latest decision, or null when none was ever taken. */
  latestOf(market: MarketContext, sellerId: Id<'Seller'>): Promise<StoredAccessDecision | null>;
}

/** Nest token of the {@link AccessDecisionRepository}. */
export const ACCESS_DECISION_REPOSITORY = Symbol('ACCESS_DECISION_REPOSITORY');
