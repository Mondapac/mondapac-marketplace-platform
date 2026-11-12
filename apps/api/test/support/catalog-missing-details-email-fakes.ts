import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { MissingDetailsEmailStore } from '../../src/modules/catalog/application/ports/missing-details-email.store';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type {
  MissingDetailsEmail,
  RecentMissingDetailsEmail,
} from '../../src/modules/catalog/domain/missing-details-email';

/**
 * {@link MissingDetailsEmailStore} in memory, per Market, with the database's rules that matter
 * to the use cases: one pending email per seller (`email.pending`), the version check of a
 * notice move, and "recent" meaning pending or sent and requested after the given instant.
 */
export class MemoryMissingDetailsEmailStore implements MissingDetailsEmailStore {
  readonly rows = new Map<string, MissingDetailsEmail>();

  all(market: MarketContext): MissingDetailsEmail[] {
    return [...this.rows.values()].filter((e) => e.state.marketId === market.marketId);
  }

  add(market: MarketContext, email: MissingDetailsEmail): Promise<'email.pending' | null> {
    if (email.state.marketId !== market.marketId) throw new Error('another Market');
    const pending = this.all(market).some(
      (e) => e.state.sellerId === email.state.sellerId && e.state.noticeState === 'pending',
    );
    if (pending) return Promise.resolve('email.pending');
    this.rows.set(`${market.marketId}/${email.state.id}`, email);
    return Promise.resolve(null);
  }

  recent(
    market: MarketContext,
    productIds: readonly string[],
    since: Temporal.Instant,
  ): Promise<readonly RecentMissingDetailsEmail[]> {
    const wanted = new Set(productIds);
    return Promise.resolve(
      this.all(market)
        .filter(
          ({ state }) =>
            (state.noticeState === 'pending' || state.noticeState === 'sent') &&
            Temporal.Instant.compare(state.requestedAt, since) > 0,
        )
        .flatMap(({ state }) =>
          state.productIds
            .filter((productId) => wanted.has(productId))
            .map((productId) => ({
              sellerId: state.sellerId,
              productId,
              at: state.sentAt ?? state.requestedAt,
            })),
        ),
    );
  }

  pendingSellers(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const wanted = new Set(sellerIds);
    return Promise.resolve(
      new Set(
        this.all(market)
          .filter(({ state }) => state.noticeState === 'pending' && wanted.has(state.sellerId))
          .map(({ state }) => state.sellerId),
      ),
    );
  }

  lastEmailed(
    market: MarketContext,
    productIds: readonly string[],
  ): Promise<ReadonlyMap<string, Temporal.Instant>> {
    const last = new Map<string, Temporal.Instant>();
    for (const { state } of this.all(market)) {
      if (state.noticeState !== 'sent' || state.sentAt === null) continue;
      for (const productId of state.productIds) {
        if (!productIds.includes(productId)) continue;
        const known = last.get(productId);
        if (known === undefined || Temporal.Instant.compare(state.sentAt, known) > 0) {
          last.set(productId, state.sentAt);
        }
      }
    }
    return Promise.resolve(last);
  }

  dueNotices(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly MissingDetailsEmail[]> {
    return Promise.resolve(
      this.all(market)
        .filter(
          ({ state }) =>
            state.noticeState === 'pending' &&
            state.noticeNextAttemptAt !== null &&
            Temporal.Instant.compare(state.noticeNextAttemptAt, now) <= 0,
        )
        .slice(0, limit),
    );
  }

  saveNotice(market: MarketContext, email: MissingDetailsEmail): Promise<void> {
    const key = `${market.marketId}/${email.state.id}`;
    const stored = this.rows.get(key);
    if (
      stored === undefined ||
      stored.state.noticeState !== 'pending' ||
      stored.state.version !== email.state.version - 1
    ) {
      throw new StaleAggregateError('missing-details-email', email.state.id);
    }
    this.rows.set(key, email);
    return Promise.resolve();
  }
}
