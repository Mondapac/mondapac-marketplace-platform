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

/**
 * A row lock that could not be taken (the row kept moving under the reader). The use cases answer
 * it as `promotions.invalid-state` (409): the caller reads again and retries.
 */
export class LockContendedError extends Error {
  constructor(readonly what: string) {
    super(`${what}-lock-contended`);
    this.name = 'LockContendedError';
  }
}

/** What a cart touches: only promotions that can apply to it are read. */
export interface LiveScope {
  readonly sellerIds: readonly Id<'Seller'>[];
  readonly productIds: readonly Id<'Product'>[];
}

/** The promotions of a Market (`promotions.promotions` and its targets and counters). */
export interface PromotionRepository {
  /** Inserts the promotion with its targets and a zeroed usage row; `duplicate-code` when the Market already has the code. */
  insert(market: MarketContext, record: PromotionRecord): Promise<'inserted' | 'duplicate-code'>;
  /** Changes the editable columns and replaces the targets as a set. */
  update(market: MarketContext, record: PromotionRecord): Promise<void>;
  /** Which of these (normalised) codes a promotion of the Market already has, in one lookup. */
  existingCodes(market: MarketContext, codes: readonly string[]): Promise<ReadonlySet<string>>;
  find(market: MarketContext, id: Id<'Promotion'>): Promise<PromotionRecord | null>;
  /**
   * The promotion with its row locked until the unit ends, so two changes of one promotion run
   * one after the other and the second decides on what the first left (a budget raise cannot slip
   * past the fresh-code check by racing another). Use it for every read that a write depends on.
   */
  findForUpdate(market: MarketContext, id: Id<'Promotion'>): Promise<PromotionRecord | null>;
  findMany(
    market: MarketContext,
    ids: readonly Id<'Promotion'>[],
  ): Promise<readonly PromotionRecord[]>;
  /** Newest first. */
  list(market: MarketContext, filter: PromotionFilter): Promise<readonly PromotionRecord[]>;
  /**
   * ACTIVE promotions that have started and not ended at `now` and that can apply to a cart with
   * these sellers and products: the platform's promotions and the promotions of a seller in the
   * cart, each without a product target or with one of the cart's products.
   */
  listLive(
    market: MarketContext,
    now: Temporal.Instant,
    scope: LiveScope,
  ): Promise<readonly PromotionRecord[]>;
  /**
   * How many promotions of the seller count against the Market maximum: ACTIVE or PENDING_APPROVAL
   * and not ended at `now`. Paused, rejected and ended promotions do not.
   */
  countCounting(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    now: Temporal.Instant,
  ): Promise<number>;
  usageOf(
    market: MarketContext,
    ids: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, UsageRecord>>;
}

export const PROMOTION_REPOSITORY = Symbol('PROMOTIONS_PROMOTION_REPOSITORY');
