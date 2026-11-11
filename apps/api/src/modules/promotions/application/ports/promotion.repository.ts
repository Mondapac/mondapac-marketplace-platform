import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { DisplayStatus } from '../../domain/display-status';
import type {
  CreatableType,
  Funding,
  PromotionRecord,
  PromotionStatus,
} from '../../domain/promotion';

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

/** What the admin list sorts by; `USES` is the count of uses (never money). */
export const PROMOTION_SORTS = ['CREATED', 'STARTS', 'ENDS', 'NAME', 'USES'] as const;
export type PromotionSort = (typeof PROMOTION_SORTS)[number];

/** A tab of the list as the repository takes it: a display status, or the open review queue. */
export type StatusCriterion = DisplayStatus | 'NEEDS_REVIEW';

/** One search of the admin list. Every part but the paging may be empty (no restriction). */
export interface PromotionSearch {
  /** Part of the name, or the start of the code; already trimmed. */
  readonly text: string | null;
  /** Empty is any type. */
  readonly types: readonly CreatableType[];
  /** Platform promotions (no owner seller) or seller promotions. */
  readonly owner: 'PLATFORM' | 'SELLER' | null;
  readonly funding: Funding | null;
  /** The tab or status filter; null is all. */
  readonly criterion: StatusCriterion | null;
  /** The promotions with an open review entry (what `NEEDS_REVIEW` means). */
  readonly reviewPromotionIds: readonly Id<'Promotion'>[];
  readonly sort: PromotionSort;
  readonly descending: boolean;
  readonly offset: number;
  readonly limit: number;
}

export interface PromotionSearchPage {
  readonly records: readonly PromotionRecord[];
  /** How many promotions match the whole search, not just this page. */
  readonly total: number;
}

/**
 * How many promotions match a search for each tab: `ALL` and every {@link StatusCriterion}.
 * The counts follow the search's text, type, owner and funding but not its own criterion.
 */
export type CriterionCounts = ReadonlyMap<StatusCriterion | 'ALL', number>;

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
  /** One page of the admin list with the number of matches; `now` decides what has ended. */
  search(
    market: MarketContext,
    search: PromotionSearch,
    now: Temporal.Instant,
  ): Promise<PromotionSearchPage>;
  /** The count of each tab for a search. */
  countByCriterion(
    market: MarketContext,
    search: PromotionSearch,
    now: Temporal.Instant,
  ): Promise<CriterionCounts>;
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
   * ACTIVE promotions of these types that have started and not ended at `now`, any owner, by id.
   * For the wallet-credit types, which are not tied to a cart's sellers or products.
   */
  listLiveOfTypes(
    market: MarketContext,
    now: Temporal.Instant,
    types: readonly PromotionRecord['type'][],
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
  /**
   * The co-funded campaigns a seller may join now: ACTIVE, not ended at `now` (a campaign that has
   * not started yet is included), and aimed at all sellers or at this one. Soonest start first.
   */
  listOpenCampaigns(
    market: MarketContext,
    now: Temporal.Instant,
    sellerId: Id<'Seller'>,
    /** Only this campaign, when given (the preview reads one). */
    promotionId?: Id<'Promotion'>,
  ): Promise<readonly PromotionRecord[]>;
  usageOf(
    market: MarketContext,
    ids: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, UsageRecord>>;
}

export const PROMOTION_REPOSITORY = Symbol('PROMOTIONS_PROMOTION_REPOSITORY');
