import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { IdentifierIndexKey } from '../../domain/business-identifier';
import type {
  RegisterChecker,
  RegisterCheck,
  RegisterMismatch,
  RegisterOutcome,
} from '../../domain/register-check';

/** One lookup's answer, ready to be recorded (the sticky rule is applied by the repository). */
export interface RegisterCheckWrite {
  readonly outcome: RegisterOutcome;
  readonly mismatches: readonly RegisterMismatch[];
  readonly checkedAt: Temporal.Instant;
  readonly checkedBy: RegisterChecker;
}

/**
 * The store of register results (sellers data design 3.4): one row per file and identifier
 * value, a primary key probe either way. Every method runs in the open unit of the use case. The
 * row of a value is never shared across sellers (design 7.7: no cross-seller cache).
 */
export interface RegisterCheckRepository {
  /** The result for this file and value, or null: a seller of another Market is null (AC 1). */
  find(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    index: IdentifierIndexKey,
  ): Promise<RegisterCheck | null>;

  /**
   * Writes the latest result of the value and answers the row as stored. A definite negative
   * already on the row survives an `unavailable` answer (AC 31, `registerCheckAfter`), also
   * under two concurrent writers; an `active` answer clears it.
   */
  record(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    index: IdentifierIndexKey,
    write: RegisterCheckWrite,
  ): Promise<RegisterCheck>;
}

export const REGISTER_CHECK_REPOSITORY = Symbol('REGISTER_CHECK_REPOSITORY');
