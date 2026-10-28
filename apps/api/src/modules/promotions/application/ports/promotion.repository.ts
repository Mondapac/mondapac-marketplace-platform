import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PromotionRecord, PromotionStatus } from '../../domain/promotion';

/** How much a promotion has been used (written by package T2; read here). */
export interface UsageRecord {
  readonly usesCount: number;
  readonly spentMinor: bigint;
  readonly sellerShareMinor: bigint;
  readonly platformShareMinor: bigint;
}

export interface PromotionFilter {
  readonly status?: PromotionStatus;
  /** A seller's own promotions; undefined for all. */
  readonly ownerSellerId?: Id<'Seller'>;
  readonly limit: number;
}

/** The promotions of a Market (`promotions.promotions` and its targets and counters). */
export interface PromotionRepository {
  /** Inserts the promotion with its targets and a zeroed usage row; `duplicate-code` when the Market already has the code. */
  insert(market: MarketContext, record: PromotionRecord): Promise<'inserted' | 'duplicate-code'>;
  /** Changes the editable columns and replaces the targets as a set. */
  update(market: MarketContext, record: PromotionRecord): Promise<void>;
  find(market: MarketContext, id: Id<'Promotion'>): Promise<PromotionRecord | null>;
  findMany(
    market: MarketContext,
    ids: readonly Id<'Promotion'>[],
  ): Promise<readonly PromotionRecord[]>;
  /** Newest first. */
  list(market: MarketContext, filter: PromotionFilter): Promise<readonly PromotionRecord[]>;
  /** ACTIVE promotions that have started and not ended at `now`. */
  listLive(market: MarketContext, now: Temporal.Instant): Promise<readonly PromotionRecord[]>;
  usageOf(
    market: MarketContext,
    ids: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, UsageRecord>>;
}

export const PROMOTION_REPOSITORY = Symbol('PROMOTIONS_PROMOTION_REPOSITORY');
