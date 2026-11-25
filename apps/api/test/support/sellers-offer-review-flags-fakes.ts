import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  OfferReviewFlagChangeEntry,
  OfferReviewFlagsRepository,
} from '../../src/modules/sellers/application/ports/offer-review-flags.repository';
import type {
  OfferReviewFlag,
  OfferReviewFlagsState,
} from '../../src/modules/sellers/domain/offer-review-flags';

const OFF = { on: false, changedAt: null, changedBy: null } as const;
const FIELD: Record<OfferReviewFlag, 'trustedFromStart' | 'fullReview' | 'reviewStop'> = {
  'trusted-from-start': 'trustedFromStart',
  'full-review': 'fullReview',
  'review-stop': 'reviewStop',
};

/** The Offer review flags of sellers and their change log in memory (version +1 per write). */
export class InMemoryOfferReviewFlags implements OfferReviewFlagsRepository {
  readonly rows = new Map<string, OfferReviewFlagsState>();
  readonly changes: (OfferReviewFlagChangeEntry & { marketId: string })[] = [];
  /** The next `set` finds another change won (0 rows). */
  loseNextSet = false;
  failReads = false;

  seed(market: MarketContext, sellerId: Id<'Seller'>, patch: Partial<OfferReviewFlagsState> = {}) {
    this.rows.set(`${market.marketId}|${sellerId}`, {
      trustedFromStart: OFF,
      fullReview: OFF,
      reviewStop: OFF,
      version: 1,
      ...patch,
    });
  }

  read(market: MarketContext, sellerId: Id<'Seller'>) {
    if (this.failReads) return Promise.reject(new Error('down'));
    return Promise.resolve(this.rows.get(`${market.marketId}|${sellerId}`) ?? null);
  }

  set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      flag: OfferReviewFlag;
      on: boolean;
      by: Id<'Account'>;
      at: Temporal.Instant;
      expectedVersion: number;
    },
  ) {
    const key = `${market.marketId}|${sellerId}`;
    const row = this.rows.get(key);
    if (this.loseNextSet || row?.version !== change.expectedVersion) {
      this.loseNextSet = false;
      return Promise.resolve(false);
    }
    this.rows.set(key, {
      ...row,
      [FIELD[change.flag]]: { on: change.on, changedAt: change.at, changedBy: change.by },
      version: row.version + 1,
    });
    return Promise.resolve(true);
  }

  countStopped(market: MarketContext) {
    if (this.failReads) return Promise.reject(new Error('down'));
    return Promise.resolve(
      [...this.rows].filter(
        ([key, row]) => key.startsWith(`${market.marketId}|`) && row.reviewStop.on,
      ).length,
    );
  }

  appendChange(market: MarketContext, entry: OfferReviewFlagChangeEntry) {
    this.changes.push({ ...entry, marketId: market.marketId });
    return Promise.resolve();
  }
}
