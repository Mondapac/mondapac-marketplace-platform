import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  AttributeValueSuggestion,
  SuggestionStatus,
} from '../../domain/attribute-value-suggestion';

/**
 * The store of sellers' value suggestions (attributes plan, package A5; catalog data design 3.30).
 * Every method runs in the open unit of the use case, through the Market-scoped client. Rows are
 * never deleted: a decision is one conditional update out of `open`, and a notice move is one
 * conditional update out of `pending`.
 */
export interface AttributeValueSuggestionStore {
  findById(
    market: MarketContext,
    id: Id<'AttributeValueSuggestion'>,
  ): Promise<AttributeValueSuggestion | null>;

  /**
   * Inserts a new open suggestion. Answers `suggestion.already-open` when the product already
   * has an open suggestion for the attribute (the open partial unique), and nothing is written.
   */
  add(
    market: MarketContext,
    suggestion: AttributeValueSuggestion,
  ): Promise<'suggestion.already-open' | null>;

  /**
   * Writes a decision built by the domain (version one above the stored one), only from `open` at
   * the version before. Throws `StaleAggregateError` when another decision won.
   */
  saveDecision(market: MarketContext, suggestion: AttributeValueSuggestion): Promise<void>;

  /**
   * Writes a notice move built by the domain, only from `pending` at the version before. Throws
   * `StaleAggregateError` when the notice moved meanwhile.
   */
  saveNotice(market: MarketContext, suggestion: AttributeValueSuggestion): Promise<void>;

  /** How many suggestions of this seller are open. */
  openCountOfSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<number>;

  /** Open suggestions, oldest first, at most `limit`. */
  listOpen(market: MarketContext, limit: number): Promise<readonly AttributeValueSuggestion[]>;

  /** One product's suggestions in every status, newest first, at most `limit`. */
  listOfProduct(
    market: MarketContext,
    productId: Id<'Product'>,
    limit: number,
  ): Promise<readonly AttributeValueSuggestion[]>;

  /**
   * One seller's suggestions, newest first (by id, a UUID v7), keyset-paged: rows after
   * `afterId` only, at most `limit`, optionally of one status.
   */
  listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      readonly status: SuggestionStatus | null;
      readonly afterId: Id<'AttributeValueSuggestion'> | null;
      readonly limit: number;
    },
  ): Promise<readonly AttributeValueSuggestion[]>;

  /** The codes of the attributes for which this product has an open suggestion. */
  openAttributeCodesOfProduct(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<ReadonlySet<string>>;

  /** Decided suggestions whose notice is pending and due at `now`, oldest first, at most `limit`. */
  dueNotices(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly AttributeValueSuggestion[]>;
}

export const ATTRIBUTE_VALUE_SUGGESTION_STORE = Symbol('ATTRIBUTE_VALUE_SUGGESTION_STORE');
