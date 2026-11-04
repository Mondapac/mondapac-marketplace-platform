import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** What the store knows about one generated code (found by the hash of the code). */
export interface BatchCodeRecord {
  readonly promotionId: Id<'Promotion'>;
  /** Null while the code is unused. Package T2 sets it when an order redeems the code. */
  readonly usedAt: Temporal.Instant | null;
}

export interface BatchCodeCount {
  readonly total: number;
  readonly used: number;
}

/**
 * The generated single-use codes of BATCH_CODE promotions (`promotions.promotion_batch_codes`).
 * Only the hash of a code is stored; the plain code exists once, in the answer of the call that
 * generated it. Every method takes the hash, never the code.
 */
export interface BatchCodeRepository {
  /** The stored record of the code with this hash, or null when no such code exists in the Market. */
  find(market: MarketContext, codeHash: string): Promise<BatchCodeRecord | null>;
  /** Which of these hashes the Market already holds (to draw again on a collision, never to overwrite). */
  existing(market: MarketContext, hashes: readonly string[]): Promise<ReadonlySet<string>>;
  /** Stores new codes of one generating call. The hashes are new (see {@link existing}). */
  insertMany(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    batchId: Id<'PromotionBatch'>,
    hashes: readonly string[],
    at: Temporal.Instant,
  ): Promise<void>;
  count(market: MarketContext, promotionId: Id<'Promotion'>): Promise<BatchCodeCount>;
}

export const BATCH_CODE_REPOSITORY = Symbol('PROMOTIONS_BATCH_CODE_REPOSITORY');
