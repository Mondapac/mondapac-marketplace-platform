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

/**
 * A decision found by its basis (slice 9a, R-5 reconciliation): ids, kind and instant only. No
 * reason is read or opened for it, and no decider.
 */
export interface AccessDecisionBasisRow {
  readonly id: Id<'AccessDecision'>;
  readonly sellerId: Id<'Seller'>;
  readonly decision: AccessDecisionKind;
  readonly basisId: Id;
  readonly decidedAt: Temporal.Instant;
}

/**
 * A stored reason that does not open (its ciphertext does not authenticate, has an unknown format,
 * or the key does not unwrap): the subject-key service's integrity failure, as this port reports
 * it (PF 4 row 7). Never an erasure. It may mean tampering, so a reader logs it as an operational
 * alert. Carries the failed check only: never the ciphertext or a value.
 */
export class AccessReasonIntegrityError extends Error {
  override readonly name = 'AccessReasonIntegrityError';
  constructor(readonly check: 'ciphertext-format' | 'ciphertext-authentication' | 'unwrap') {
    super(`identity.access_decisions: a stored reason failed its integrity check: ${check}`);
  }
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

  /**
   * The seller's decisions, newest first (`decided_at`, then id), at most `limit` (slice 9a,
   * R-5), with their reasons opened as {@link findById} does: a destroyed key is `reasonErased`;
   * a ciphertext that does not open throws {@link AccessReasonIntegrityError}. Another Market's seller or an unknown id: none.
   */
  historyOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    limit: number,
  ): Promise<readonly StoredAccessDecision[]>;

  /**
   * The decisions of this Market whose `basis_id` is one of `basisIds` (slice 9a, R-5
   * reconciliation), on the index (market_id, basis_id). Nothing is decrypted. The caller
   * matches the seller of each row against the pair it asked for.
   */
  findByBasis(
    market: MarketContext,
    basisIds: readonly Id[],
  ): Promise<readonly AccessDecisionBasisRow[]>;
}

/** Nest token of the {@link AccessDecisionRepository}. */
export const ACCESS_DECISION_REPOSITORY = Symbol('ACCESS_DECISION_REPOSITORY');
