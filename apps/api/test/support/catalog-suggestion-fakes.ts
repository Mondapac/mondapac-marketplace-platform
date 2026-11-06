import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AttributeValueSuggestionStore } from '../../src/modules/catalog/application/ports/attribute-value-suggestion.store';
import type {
  AttributeValueSuggestion,
  SuggestionStatus,
} from '../../src/modules/catalog/domain/attribute-value-suggestion';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

/**
 * Value suggestions in memory (attributes plan, package A5), with the SQL store's rules: one open
 * suggestion per product and definition, a decision only out of `open` at the version before, a
 * notice move only out of `pending` at the version before. The SQL store is proved in
 * test/db/catalog-attribute-suggestions.db-spec.ts.
 */
export class MemoryAttributeValueSuggestionStore implements AttributeValueSuggestionStore {
  readonly rows = new Map<string, AttributeValueSuggestion>();
  /** Definition id to code, for `openAttributeCodesOfProduct` (the SQL store joins). */
  readonly codes = new Map<string, string>();
  /** Set to make the next decision lose a race. */
  raceNext = false;

  reset(): void {
    this.rows.clear();
    this.codes.clear();
    this.raceNext = false;
  }

  findById(market: MarketContext, id: Id<'AttributeValueSuggestion'>) {
    const row = this.rows.get(id);
    return Promise.resolve(row?.state.marketId === market.marketId ? row : null);
  }

  add(market: MarketContext, suggestion: AttributeValueSuggestion) {
    const clash = [...this.rows.values()].some(
      (row) =>
        row.state.marketId === market.marketId &&
        row.state.status === 'open' &&
        row.state.productId === suggestion.state.productId &&
        row.state.definitionId === suggestion.state.definitionId,
    );
    if (clash) return Promise.resolve('suggestion.already-open' as const);
    this.rows.set(suggestion.state.id, suggestion);
    return Promise.resolve(null);
  }

  saveDecision(_market: MarketContext, suggestion: AttributeValueSuggestion) {
    const stored = this.rows.get(suggestion.state.id);
    if (
      this.raceNext ||
      stored === undefined ||
      stored.state.status !== 'open' ||
      stored.state.version !== suggestion.state.version - 1
    ) {
      this.raceNext = false;
      return Promise.reject(
        new StaleAggregateError('attribute-value-suggestion', suggestion.state.id),
      );
    }
    this.rows.set(suggestion.state.id, suggestion);
    return Promise.resolve();
  }

  saveNotice(_market: MarketContext, suggestion: AttributeValueSuggestion) {
    const stored = this.rows.get(suggestion.state.id);
    if (
      stored === undefined ||
      stored.state.noticeState !== 'pending' ||
      stored.state.version !== suggestion.state.version - 1
    ) {
      return Promise.reject(
        new StaleAggregateError('attribute-value-suggestion', suggestion.state.id),
      );
    }
    this.rows.set(suggestion.state.id, suggestion);
    return Promise.resolve();
  }

  openCountOfSeller(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) =>
          row.state.marketId === market.marketId &&
          row.state.sellerId === sellerId &&
          row.state.status === 'open',
      ).length,
    );
  }

  listOpen(market: MarketContext, limit: number) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.state.marketId === market.marketId && row.state.status === 'open')
        .sort((a, b) => a.state.createdAt.epochMilliseconds - b.state.createdAt.epochMilliseconds)
        .slice(0, limit),
    );
  }

  listOfProduct(market: MarketContext, productId: Id<'Product'>, limit: number) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) => row.state.marketId === market.marketId && row.state.productId === productId,
        )
        .sort((a, b) => b.state.createdAt.epochMilliseconds - a.state.createdAt.epochMilliseconds)
        .slice(0, limit),
    );
  }

  listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      readonly status: SuggestionStatus | null;
      readonly afterId: Id<'AttributeValueSuggestion'> | null;
      readonly limit: number;
    },
  ) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.state.marketId === market.marketId &&
            row.state.sellerId === sellerId &&
            (page.status === null || row.state.status === page.status) &&
            (page.afterId === null || row.state.id < page.afterId),
        )
        .sort((a, b) => (a.state.id < b.state.id ? 1 : a.state.id > b.state.id ? -1 : 0))
        .slice(0, page.limit),
    );
  }

  openAttributeCodesOfProduct(market: MarketContext, productId: Id<'Product'>) {
    return Promise.resolve(
      new Set(
        [...this.rows.values()]
          .filter(
            (row) =>
              row.state.marketId === market.marketId &&
              row.state.productId === productId &&
              row.state.status === 'open',
          )
          .map((row) => this.codes.get(row.state.definitionId) ?? row.state.definitionId),
      ),
    );
  }

  dueNotices(market: MarketContext, now: Temporal.Instant, limit: number) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.state.marketId === market.marketId &&
            row.state.noticeState === 'pending' &&
            row.state.noticeNextAttemptAt !== null &&
            row.state.noticeNextAttemptAt.epochMilliseconds <= now.epochMilliseconds,
        )
        .slice(0, limit),
    );
  }
}
