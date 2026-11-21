import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import { inCreatedRange, type CreatedRange } from './created-range';
import type { AttributeValueSuggestionStore } from '../../src/modules/catalog/application/ports/attribute-value-suggestion.store';
import type {
  AttributeValueSuggestion,
  SuggestionStatus,
} from '../../src/modules/catalog/domain/attribute-value-suggestion';
import type { TopicSuggestionStore } from '../../src/modules/catalog/application/ports/topic-suggestion.store';
import type {
  SuggestionStatus as TopicSuggestionStatus,
  TopicSuggestion,
} from '../../src/modules/catalog/domain/topic-suggestion';
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

  #open(market: MarketContext, filter: { text: string | null } & CreatedRange) {
    return [...this.rows.values()].filter(
      (row) =>
        row.state.marketId === market.marketId &&
        row.state.status === 'open' &&
        inCreatedRange(row.state.createdAt, filter) &&
        (filter.text === null || row.state.label.toLowerCase().includes(filter.text.toLowerCase())),
    );
  }

  pageOpen(
    market: MarketContext,
    page: {
      text: string | null;
      direction: 'asc' | 'desc';
      offset: number;
      limit: number;
    } & CreatedRange,
  ) {
    const sign = page.direction === 'asc' ? 1 : -1;
    return Promise.resolve(
      this.#open(market, page)
        .sort(
          (a, b) =>
            sign * (a.state.createdAt.epochMilliseconds - b.state.createdAt.epochMilliseconds),
        )
        .slice(page.offset, page.offset + page.limit),
    );
  }

  countOpen(market: MarketContext, filter: { text: string | null } & CreatedRange) {
    return Promise.resolve(this.#open(market, filter).length);
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

  #own(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filter: { status: SuggestionStatus | null; text: string | null } & CreatedRange,
  ) {
    return [...this.rows.values()].filter(
      ({ state }) =>
        state.marketId === market.marketId &&
        state.sellerId === sellerId &&
        (filter.status === null || state.status === filter.status) &&
        inCreatedRange(state.createdAt, filter) &&
        (filter.text === null || state.label.toLowerCase().includes(filter.text.toLowerCase())),
    );
  }

  pageOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      status: SuggestionStatus | null;
      text: string | null;
      createdFrom?: Temporal.Instant | null;
      createdTo?: Temporal.Instant | null;
      sort: 'created' | 'status' | 'label';
      direction: 'asc' | 'desc';
      offset: number;
      limit: number;
    },
  ) {
    const sign = page.direction === 'asc' ? 1 : -1;
    const created = (
      a: { state: { createdAt: { epochMilliseconds: number }; id: string } },
      b: typeof a,
    ) =>
      a.state.createdAt.epochMilliseconds - b.state.createdAt.epochMilliseconds ||
      (a.state.id < b.state.id ? -1 : 1);
    return Promise.resolve(
      this.#own(market, sellerId, page)
        .sort((a, b) => {
          if (page.sort === 'status') {
            return a.state.status === b.state.status
              ? -created(a, b)
              : sign * (a.state.status < b.state.status ? -1 : 1);
          }
          if (page.sort === 'label') {
            return a.state.label === b.state.label
              ? sign * (a.state.id < b.state.id ? -1 : 1)
              : sign * (a.state.label < b.state.label ? -1 : 1);
          }
          return sign * created(a, b);
        })
        .slice(page.offset, page.offset + page.limit),
    );
  }

  countOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filter: { status: SuggestionStatus | null; text: string | null } & CreatedRange,
  ) {
    return Promise.resolve(this.#own(market, sellerId, filter).length);
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

/**
 * Tag suggestions in memory (product tags package T5), with the SQL store's rules: one open
 * suggestion per seller and text key, a decision only out of `open` at the version before, a
 * notice move only out of `pending`. The SQL store is proved in
 * test/db/catalog-topic-suggestions.db-spec.ts.
 */
export class MemoryTopicSuggestionStore implements TopicSuggestionStore {
  readonly rows = new Map<string, TopicSuggestion>();

  reset(): void {
    this.rows.clear();
  }

  findById(market: MarketContext, id: Id<'TopicSuggestion'>) {
    const row = this.rows.get(id);
    return Promise.resolve(row?.state.marketId === market.marketId ? row : null);
  }

  add(market: MarketContext, suggestion: TopicSuggestion) {
    const clash = [...this.rows.values()].some(
      ({ state }) =>
        state.marketId === market.marketId &&
        state.status === 'open' &&
        state.sellerId === suggestion.state.sellerId &&
        state.labelKey === suggestion.state.labelKey,
    );
    if (clash) return Promise.resolve('suggestion.already-open' as const);
    this.rows.set(suggestion.state.id, suggestion);
    return Promise.resolve(null);
  }

  saveDecision(_market: MarketContext, suggestion: TopicSuggestion) {
    const stored = this.rows.get(suggestion.state.id);
    if (
      stored === undefined ||
      stored.state.status !== 'open' ||
      stored.state.version !== suggestion.state.version - 1
    ) {
      return Promise.reject(new StaleAggregateError('topic-suggestion', suggestion.state.id));
    }
    this.rows.set(suggestion.state.id, suggestion);
    return Promise.resolve();
  }

  saveNotice(_market: MarketContext, suggestion: TopicSuggestion) {
    this.rows.set(suggestion.state.id, suggestion);
    return Promise.resolve();
  }

  openCountOfSeller(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      [...this.rows.values()].filter(
        ({ state }) =>
          state.marketId === market.marketId &&
          state.sellerId === sellerId &&
          state.status === 'open',
      ).length,
    );
  }

  #open(market: MarketContext, filter: { text: string | null } & CreatedRange) {
    return [...this.rows.values()].filter(
      ({ state }) =>
        state.marketId === market.marketId &&
        state.status === 'open' &&
        inCreatedRange(state.createdAt, filter) &&
        (filter.text === null || state.label.toLowerCase().includes(filter.text.toLowerCase())),
    );
  }

  pageOpen(
    market: MarketContext,
    page: {
      text: string | null;
      direction: 'asc' | 'desc';
      offset: number;
      limit: number;
    } & CreatedRange,
  ) {
    const sign = page.direction === 'asc' ? 1 : -1;
    return Promise.resolve(
      this.#open(market, page)
        .sort(
          (a, b) =>
            sign * (a.state.createdAt.epochMilliseconds - b.state.createdAt.epochMilliseconds),
        )
        .slice(page.offset, page.offset + page.limit),
    );
  }

  countOpen(market: MarketContext, filter: { text: string | null } & CreatedRange) {
    return Promise.resolve(this.#open(market, filter).length);
  }

  listOfProduct(market: MarketContext, productId: Id<'Product'>, limit: number) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(({ state }) => state.marketId === market.marketId && state.productId === productId)
        .slice(0, limit),
    );
  }

  #own(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filter: { status: TopicSuggestionStatus | null; text: string | null } & CreatedRange,
  ) {
    return [...this.rows.values()].filter(
      ({ state }) =>
        state.marketId === market.marketId &&
        state.sellerId === sellerId &&
        (filter.status === null || state.status === filter.status) &&
        inCreatedRange(state.createdAt, filter) &&
        (filter.text === null || state.label.toLowerCase().includes(filter.text.toLowerCase())),
    );
  }

  pageOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      status: TopicSuggestionStatus | null;
      text: string | null;
      createdFrom?: Temporal.Instant | null;
      createdTo?: Temporal.Instant | null;
      sort: 'created' | 'status' | 'label';
      direction: 'asc' | 'desc';
      offset: number;
      limit: number;
    },
  ) {
    const sign = page.direction === 'asc' ? 1 : -1;
    const created = (
      a: { state: { createdAt: { epochMilliseconds: number }; id: string } },
      b: typeof a,
    ) =>
      a.state.createdAt.epochMilliseconds - b.state.createdAt.epochMilliseconds ||
      (a.state.id < b.state.id ? -1 : 1);
    return Promise.resolve(
      this.#own(market, sellerId, page)
        .sort((a, b) => {
          if (page.sort === 'status') {
            return a.state.status === b.state.status
              ? -created(a, b)
              : sign * (a.state.status < b.state.status ? -1 : 1);
          }
          if (page.sort === 'label') {
            return a.state.label === b.state.label
              ? sign * (a.state.id < b.state.id ? -1 : 1)
              : sign * (a.state.label < b.state.label ? -1 : 1);
          }
          return sign * created(a, b);
        })
        .slice(page.offset, page.offset + page.limit),
    );
  }

  countOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filter: { status: TopicSuggestionStatus | null; text: string | null } & CreatedRange,
  ) {
    return Promise.resolve(this.#own(market, sellerId, filter).length);
  }

  listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      readonly status: TopicSuggestionStatus | null;
      readonly afterId: Id<'TopicSuggestion'> | null;
      readonly limit: number;
    },
  ) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          ({ state }) =>
            state.marketId === market.marketId &&
            state.sellerId === sellerId &&
            (page.status === null || state.status === page.status) &&
            (page.afterId === null || state.id < page.afterId),
        )
        .sort((a, b) => (a.state.id < b.state.id ? 1 : -1))
        .slice(0, page.limit),
    );
  }

  dueNotices(market: MarketContext, now: Temporal.Instant, limit: number) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          ({ state }) =>
            state.marketId === market.marketId &&
            state.noticeState === 'pending' &&
            state.noticeNextAttemptAt !== null &&
            state.noticeNextAttemptAt.epochMilliseconds <= now.epochMilliseconds,
        )
        .slice(0, limit),
    );
  }
}
