import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  SellerHealth,
  SellerHealthInput,
  SellerHealthMetric,
} from '../../domain/seller-health';
import type { SellerHealthDay } from '../../domain/seller-health-days';

/** The daily snapshot of one seller's score, as stored (data: sellers.seller_health_snapshots). */
export interface SellerHealthSnapshot {
  readonly day: Temporal.PlainDate;
  readonly health: SellerHealth;
  /** The counts the score was computed from, kept for the card and for tracing a formula change. */
  readonly inputs: SellerHealthInput;
  readonly computedAt: Temporal.Instant;
}

/** What a list shows of a seller's latest snapshot: the band and score, never the metrics. */
export interface SellerHealthSummary {
  readonly day: Temporal.PlainDate;
  readonly kind: 'scored' | 'new' | 'no-data';
  readonly band: 'healthy' | 'at-risk' | 'unhealthy' | null;
  readonly score: number | null;
  /** The metric that set a scored seller's score; null unless `scored`. */
  readonly lowestMetric: SellerHealthMetric | null;
}

/** Cap on the sellers the "Needs a look" queue reads; beyond it the answer says `truncated`. */
export const UNHEALTHY_QUEUE_MAX = 200;

/**
 * `sellers.seller_health_days` and `sellers.seller_health_snapshots`. Runs in the caller's open
 * read-write unit. A day or snapshot written again for the same seller and local day replaces
 * the earlier one, so a repeat or a recalculation never counts twice.
 */
export interface SellerHealthStore {
  /** Sets the counters of one local day (the whole row). */
  saveDay(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    day: SellerHealthDay,
    recountedAt: Temporal.Instant,
  ): Promise<void>;

  /** The seller's counters for the dates from `from` to `to`, both included. */
  days(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly SellerHealthDay[]>;

  saveSnapshot(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    snapshot: SellerHealthSnapshot,
  ): Promise<void>;

  /** The seller's snapshots from `from` to `to`, oldest first (the 90-day trend). */
  snapshots(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly SellerHealthSnapshot[]>;

  /**
   * The newest snapshot of each seller in `sellerIds` among the dates from `from` to `to`, as a
   * summary; a seller with none in that range is absent from the map. One query for the whole
   * list page (no N+1).
   */
  latest(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<ReadonlyMap<Id<'Seller'>, SellerHealthSummary>>;

  /**
   * The sellers whose newest snapshot among the dates from `from` to `to` is `unhealthy`: worst
   * score first, ties by seller id, at most `UNHEALTHY_QUEUE_MAX` of them. `truncated` is true
   * when more sellers were unhealthy than the cap, or too many candidates were read to check
   * them all (the candidate read is bounded).
   */
  unhealthy(
    market: MarketContext,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
    /** The cap; `UNHEALTHY_QUEUE_MAX` when left out. Only tests pass it. */
    limit?: number,
  ): Promise<{
    readonly sellers: readonly (SellerHealthSummary & { readonly sellerId: Id<'Seller'> })[];
    readonly truncated: boolean;
  }>;

  /**
   * Deletes the Market's counters and snapshots of local dates before `before`, of every seller,
   * and answers how many rows went. Only the retention purge calls it.
   */
  purgeBefore(
    market: MarketContext,
    before: Temporal.PlainDate,
  ): Promise<{ readonly days: number; readonly snapshots: number }>;
}

export const SELLER_HEALTH_STORE = Symbol('SELLER_HEALTH_STORE');
