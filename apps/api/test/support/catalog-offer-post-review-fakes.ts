import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type {
  OfferPostReviewFilter,
  OfferPostReviewPage,
  OfferPostReviewReasonReceipt,
  OfferPostReviewRepository,
  OfferPostReviewSampler,
} from '../../src/modules/catalog/application/ports/offer-post-review';
import {
  OfferPostReview,
  type OfferPostReviewState,
  type OfferPostReviewStatus,
} from '../../src/modules/catalog/domain/offer-post-review';

/**
 * The post-publication review rows in memory, with the rules of the tables: one open row per
 * Offer (a second insert is `StaleAggregateError`, as the partial unique), a conditional update on
 * the version read, insert-only reasons keyed on (Market, Offer, reason, source), and the Market
 * filter of every read.
 */
export class InMemoryOfferPostReviews implements OfferPostReviewRepository {
  readonly rows = new Map<string, OfferPostReviewState>();
  readonly receipts = new Map<string, OfferPostReviewReasonReceipt & { marketId: string }>();
  /** Accounts behind the Offers' submits, by Offer id. */
  readonly submitters = new Map<string, Set<Id<'Account'>>>();
  /** Set to make `everTakenDown` reject (the read failure of the resubmit fact). */
  failTakenDownRead = false;

  insert(market: MarketContext, review: OfferPostReview): Promise<void> {
    const state = review.state;
    if (state.marketId !== market.marketId) throw new Error('insert: another Market');
    const open = [...this.rows.values()].some(
      (row) =>
        row.marketId === market.marketId && row.offerId === state.offerId && row.status === 'open',
    );
    if (open) return Promise.reject(new StaleAggregateError('offer-post-review', state.offerId));
    this.rows.set(state.id, state);
    return Promise.resolve();
  }

  save(market: MarketContext, review: OfferPostReview): Promise<boolean> {
    const stored = this.rows.get(review.state.id);
    if (
      stored === undefined ||
      stored.marketId !== market.marketId ||
      stored.version !== review.loadedVersion
    ) {
      return Promise.resolve(false);
    }
    if (stored.status !== 'open') throw new Error('guard: a decided row never changes');
    this.rows.set(review.state.id, review.state);
    return Promise.resolve(true);
  }

  #key(marketId: string, offerId: string, reason: string, sourceRef: string): string {
    return JSON.stringify([marketId, offerId, reason, sourceRef]);
  }

  receive(market: MarketContext, receipt: OfferPostReviewReasonReceipt): Promise<boolean> {
    const key = this.#key(market.marketId, receipt.offerId, receipt.reason, receipt.sourceRef);
    if (this.receipts.has(key)) return Promise.resolve(false);
    this.receipts.set(key, { ...receipt, marketId: market.marketId });
    return Promise.resolve(true);
  }

  received(
    market: MarketContext,
    key: Pick<OfferPostReviewReasonReceipt, 'offerId' | 'reason' | 'sourceRef'>,
  ): Promise<boolean> {
    return Promise.resolve(
      this.receipts.has(this.#key(market.marketId, key.offerId, key.reason, key.sourceRef)),
    );
  }

  findOpenByOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<OfferPostReview | null> {
    const row = [...this.rows.values()].find(
      (r) => r.marketId === market.marketId && r.offerId === offerId && r.status === 'open',
    );
    return Promise.resolve(row === undefined ? null : OfferPostReview.restore(row));
  }

  findById(market: MarketContext, id: Id<'OfferPostReview'>): Promise<OfferPostReview | null> {
    const row = this.rows.get(id);
    return Promise.resolve(
      row === undefined || row.marketId !== market.marketId ? null : OfferPostReview.restore(row),
    );
  }

  findManyByIds(
    market: MarketContext,
    ids: readonly Id<'OfferPostReview'>[],
  ): Promise<readonly OfferPostReview[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const row = this.rows.get(id);
        return row === undefined || row.marketId !== market.marketId
          ? []
          : [OfferPostReview.restore(row)];
      }),
    );
  }

  everTakenDown(market: MarketContext, offerId: Id<'Offer'>): Promise<boolean> {
    if (this.failTakenDownRead) return Promise.reject(new Error('down'));
    return Promise.resolve(
      [...this.rows.values()].some(
        (r) => r.marketId === market.marketId && r.offerId === offerId && r.status === 'taken-down',
      ),
    );
  }

  #filtered(market: MarketContext, filter: OfferPostReviewFilter): OfferPostReviewState[] {
    return [...this.rows.values()].filter(
      (r) =>
        r.marketId === market.marketId &&
        (filter.status === undefined || r.status === filter.status) &&
        (filter.sellerId === undefined || r.sellerId === filter.sellerId) &&
        (filter.reasons === undefined ||
          filter.reasons.length === 0 ||
          r.reasons.some((reason) => filter.reasons?.includes(reason))) &&
        (filter.openedFrom == null ||
          Temporal.Instant.compare(r.openedAt, filter.openedFrom) >= 0) &&
        (filter.openedTo == null || Temporal.Instant.compare(r.openedAt, filter.openedTo) < 0),
    );
  }

  list(
    market: MarketContext,
    page: OfferPostReviewPage,
    filter: OfferPostReviewFilter,
  ): Promise<readonly OfferPostReview[]> {
    const sign = page.direction === 'asc' ? 1 : -1;
    const rows = this.#filtered(market, filter).sort(
      (a, b) =>
        sign *
        (Temporal.Instant.compare(a.openedAt, b.openedAt) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
    return Promise.resolve(
      rows.slice(page.offset, page.offset + page.limit).map((row) => OfferPostReview.restore(row)),
    );
  }

  count(market: MarketContext, filter: OfferPostReviewFilter): Promise<number> {
    return Promise.resolve(this.#filtered(market, filter).length);
  }

  sellerIds(
    market: MarketContext,
    status: OfferPostReviewStatus | undefined,
    limit: number,
  ): Promise<readonly Id<'Seller'>[]> {
    const ids = new Set(
      this.#filtered(market, status === undefined ? {} : { status }).map((r) => r.sellerId),
    );
    return Promise.resolve([...ids].sort().slice(0, limit));
  }

  submitterAccountIds(
    _market: MarketContext,
    offerId: Id<'Offer'>,
  ): Promise<ReadonlySet<Id<'Account'>>> {
    return Promise.resolve(this.submitters.get(offerId) ?? new Set());
  }

  /** The rows of one Offer, oldest first. */
  ofOffer(offerId: string): OfferPostReviewState[] {
    return [...this.rows.values()]
      .filter((row) => row.offerId === offerId)
      .sort((a, b) => Temporal.Instant.compare(a.openedAt, b.openedAt));
  }
}

/** A sampler that answers a fixed bucket (or throws), recording what it was asked. */
export function fixedSampler(bucket: number | 'throw'): OfferPostReviewSampler & {
  readonly asked: { marketId: string; offerId: string; offerVersion: number }[];
} {
  const asked: { marketId: string; offerId: string; offerVersion: number }[] = [];
  return {
    asked,
    bucketOf(market, offerId, offerVersion) {
      asked.push({ marketId: market.marketId, offerId, offerVersion });
      if (bucket === 'throw') throw new Error('sampler down');
      return bucket;
    },
  };
}
