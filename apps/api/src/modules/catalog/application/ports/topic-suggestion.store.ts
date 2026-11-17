import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { TopicSuggestion, SuggestionStatus } from '../../domain/topic-suggestion';

/**
 * The store of sellers' tag suggestions (product tags package T5).
 * Every method runs in the open unit of the use case, through the Market-scoped client. Rows are
 * never deleted: a decision is one conditional update out of `open`, and a notice move is one
 * conditional update out of `pending`.
 */
export interface TopicSuggestionStore {
  findById(market: MarketContext, id: Id<'TopicSuggestion'>): Promise<TopicSuggestion | null>;

  /**
   * Inserts a new open suggestion. Answers `suggestion.already-open` when the seller already
   * has an open suggestion with the same text key (the open partial unique), and nothing is written.
   */
  add(
    market: MarketContext,
    suggestion: TopicSuggestion,
  ): Promise<'suggestion.already-open' | null>;

  /**
   * Writes a decision built by the domain (version one above the stored one), only from `open` at
   * the version before. Throws `StaleAggregateError` when another decision won.
   */
  saveDecision(market: MarketContext, suggestion: TopicSuggestion): Promise<void>;

  /**
   * Writes a notice move built by the domain, only from `pending` at the version before. Throws
   * `StaleAggregateError` when the notice moved meanwhile.
   */
  saveNotice(market: MarketContext, suggestion: TopicSuggestion): Promise<void>;

  /** How many suggestions of this seller are open. */
  openCountOfSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<number>;

  /** Open suggestions, oldest first, at most `limit`. */
  listOpen(market: MarketContext, limit: number): Promise<readonly TopicSuggestion[]>;

  /** One product's suggestions in every status, newest first, at most `limit`. */
  listOfProduct(
    market: MarketContext,
    productId: Id<'Product'>,
    limit: number,
  ): Promise<readonly TopicSuggestion[]>;

  /**
   * One seller's suggestions, newest first (by id, a UUID v7), keyset-paged: rows after
   * `afterId` only, at most `limit`, optionally of one status.
   */
  listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      readonly status: SuggestionStatus | null;
      readonly afterId: Id<'TopicSuggestion'> | null;
      readonly limit: number;
    },
  ): Promise<readonly TopicSuggestion[]>;

  /** Decided suggestions whose notice is pending and due at `now`, oldest first, at most `limit`. */
  dueNotices(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly TopicSuggestion[]>;
}

export const TOPIC_SUGGESTION_STORE = Symbol('TOPIC_SUGGESTION_STORE');
