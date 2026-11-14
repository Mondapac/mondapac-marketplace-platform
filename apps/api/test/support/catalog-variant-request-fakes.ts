import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { VariantRequestStore } from '../../src/modules/catalog/application/ports/variant-request.store';
import type {
  VariantRequest,
  VariantRequestStatus,
} from '../../src/modules/catalog/domain/variant-request';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

/**
 * Variant requests in memory (variants plan, package V7), with the SQL store's rules: one open
 * request per Offer and combination, a decision only out of `open` at the version before, a notice
 * move only out of `pending` at the version before. The SQL store is proved in
 * test/db/catalog-variant-requests.db-spec.ts.
 */
export class MemoryVariantRequestStore implements VariantRequestStore {
  readonly rows = new Map<string, VariantRequest>();
  /** Set to make the next decision lose a race. */
  raceNext = false;

  reset(): void {
    this.rows.clear();
    this.raceNext = false;
  }

  findById(market: MarketContext, id: Id<'VariantRequest'>) {
    const row = this.rows.get(id);
    return Promise.resolve(row?.state.marketId === market.marketId ? row : null);
  }

  add(market: MarketContext, request: VariantRequest) {
    const clash = [...this.rows.values()].some(
      (row) =>
        row.state.marketId === market.marketId &&
        row.state.status === 'open' &&
        row.state.offerId === request.state.offerId &&
        row.state.optionKey === request.state.optionKey,
    );
    if (clash) return Promise.resolve('variant-request.already-open' as const);
    this.rows.set(request.state.id, request);
    return Promise.resolve(null);
  }

  saveDecision(_market: MarketContext, request: VariantRequest) {
    const stored = this.rows.get(request.state.id);
    if (
      this.raceNext ||
      stored === undefined ||
      stored.state.status !== 'open' ||
      stored.state.version !== request.state.version - 1
    ) {
      this.raceNext = false;
      return Promise.reject(new StaleAggregateError('variant-request', request.state.id));
    }
    this.rows.set(request.state.id, request);
    return Promise.resolve();
  }

  saveNotice(_market: MarketContext, request: VariantRequest) {
    const stored = this.rows.get(request.state.id);
    if (
      stored === undefined ||
      stored.state.noticeState !== 'pending' ||
      stored.state.version !== request.state.version - 1
    ) {
      return Promise.reject(new StaleAggregateError('variant-request', request.state.id));
    }
    this.rows.set(request.state.id, request);
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

  madeSince(market: MarketContext, sellerId: Id<'Seller'>, since: Temporal.Instant) {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) =>
          row.state.marketId === market.marketId &&
          row.state.sellerId === sellerId &&
          row.state.createdAt.epochMilliseconds >= since.epochMilliseconds,
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

  listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      readonly status: VariantRequestStatus | null;
      readonly afterId: Id<'VariantRequest'> | null;
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
