import type { AuditEntry, CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { SellerReviewProbation } from '../../src/modules/catalog/application/seller-review-probation';
import type {
  SellerOfferReviewFlags,
  SellerOfferReviewFlagsReader,
} from '../../src/modules/catalog/application/ports/seller-offer-review-flags.reader';
import type {
  SellerReviewCredit,
  SellerReviewStandingRepository,
} from '../../src/modules/catalog/application/ports/seller-review-standing.repository';
import {
  SellerReviewStanding,
  type SellerReviewStandingState,
} from '../../src/modules/catalog/domain/seller-review-standing';
import type {
  CategoryOfferReviewChangeEntry,
  CategoryOfferReviewFlagsStore,
} from '../../src/modules/catalog/application/ports/category-offer-review-flags.store';
import {
  CategoryOfferReviewFlags,
  type CategoryOfferReviewFlagsState,
} from '../../src/modules/catalog/domain/category-offer-review-flags';

const key = (market: MarketContext, sellerId: string) => `${market.marketId}|${sellerId}`;

/**
 * The standings and credits in memory, with the rules of the tables: the version rises by one per
 * write, a credit is once per product per epoch and only in the standing's current epoch, and
 * (when `inUnit` is set) every statement runs in a unit.
 */
export class InMemorySellerReviewStandings implements SellerReviewStandingRepository {
  readonly rows = new Map<string, SellerReviewStandingState>();
  readonly credits: (SellerReviewCredit & { readonly marketId: string })[] = [];
  /** Every statement checks it runs in a unit when set. */
  inUnit: (() => boolean) | null = null;
  /** The next statement throws (a failed read or write). */
  failNext = false;
  locks = 0;

  #check(): void {
    if (this.inUnit !== null && !this.inUnit()) throw new Error('standing outside a unit');
    if (this.failNext) {
      this.failNext = false;
      throw new Error('standing store down');
    }
  }

  lock(market: MarketContext, sellerId: Id<'Seller'>, now: Temporal.Instant) {
    this.#check();
    const k = key(market, sellerId);
    const stored =
      this.rows.get(k) ??
      SellerReviewStanding.start({ marketId: market.marketId, sellerId, now }).state;
    const locked = { ...stored, version: stored.version + 1, updatedAt: now };
    this.rows.set(k, locked);
    this.locks += 1;
    return Promise.resolve(SellerReviewStanding.restore(locked));
  }

  save(market: MarketContext, standing: SellerReviewStanding) {
    this.#check();
    const k = key(market, standing.state.sellerId);
    const stored = this.rows.get(k);
    if (stored?.version !== standing.state.version) {
      throw new StaleAggregateError('seller-review-standing', standing.state.sellerId);
    }
    if (standing.state.epoch !== stored.epoch && standing.state.epoch !== stored.epoch + 1) {
      throw new Error('epoch moves forward by one');
    }
    this.rows.set(k, { ...standing.state, version: stored.version + 1 });
    return Promise.resolve();
  }

  credit(market: MarketContext, credit: SellerReviewCredit) {
    this.#check();
    const stored = this.rows.get(key(market, credit.sellerId));
    if (stored?.epoch !== credit.epoch) throw new Error('a credit is in the current epoch');
    const exists = this.credits.some(
      (row) =>
        row.marketId === market.marketId &&
        row.sellerId === credit.sellerId &&
        row.epoch === credit.epoch &&
        row.productId === credit.productId,
    );
    if (!exists) this.credits.push({ ...credit, marketId: market.marketId });
    return Promise.resolve(!exists);
  }

  count(market: MarketContext, sellerId: Id<'Seller'>, epoch: number) {
    this.#check();
    return Promise.resolve(
      this.credits.filter(
        (row) =>
          row.marketId === market.marketId && row.sellerId === sellerId && row.epoch === epoch,
      ).length,
    );
  }

  async read(market: MarketContext, sellerId: Id<'Seller'>) {
    this.#check();
    const state = this.rows.get(key(market, sellerId));
    if (state === undefined) return null;
    return { state, count: await this.count(market, sellerId, state.epoch) };
  }
}

export const FLAGS_OFF: SellerOfferReviewFlags = Object.freeze({
  trustedFromStart: { on: false, at: null },
  fullReview: { on: false, at: null },
  reviewStop: { on: false, at: null },
});

/** A {@link SellerReviewProbation} over memory, with the seller's flags and N as given. */
export function memoryProbation(
  options: {
    readonly standings?: InMemorySellerReviewStandings;
    /** N; default 10. */
    readonly probationOffers?: number | (() => number);
    /** The seller flags; null: sellers cannot answer. */
    readonly flags?: SellerOfferReviewFlags | null | (() => SellerOfferReviewFlags | null);
  } = {},
) {
  const standings = options.standings ?? new InMemorySellerReviewStandings();
  const audits: AuditEntry[] = [];
  const audit: AuditWriter = {
    record: (_context: CallContext, entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const sellerFlags: SellerOfferReviewFlagsReader = {
    flagsOf: () =>
      Promise.resolve(
        typeof options.flags === 'function'
          ? options.flags()
          : options.flags === undefined
            ? FLAGS_OFF
            : options.flags,
      ),
  };
  const probation = new SellerReviewProbation({
    standings,
    sellerFlags,
    inputs: {
      probationOffers: () =>
        Promise.resolve(
          typeof options.probationOffers === 'function'
            ? options.probationOffers()
            : (options.probationOffers ?? 10),
        ),
    },
    audit,
  });
  return { probation, standings, sellerFlags, audits };
}

/**
 * The Offer review flags of categories in memory, with the rules of the tables: the row is
 * created at version 1 and raised by one per write, and the change log is insert-only.
 */
export class InMemoryCategoryOfferReviewFlags implements CategoryOfferReviewFlagsStore {
  readonly rows = new Map<string, CategoryOfferReviewFlagsState>();
  readonly changes: (CategoryOfferReviewChangeEntry & { readonly marketId: string })[] = [];
  /** `${marketId}|${categoryId}` of the platform categories that exist. */
  readonly categories = new Set<string>();
  /** The published categories of each product (`${marketId}|${productId}`). */
  readonly published = new Map<string, readonly string[]>();
  /** The next save finds another change won. */
  loseNextSave = false;
  failReads = false;

  addCategory(market: MarketContext, categoryId: string): void {
    this.categories.add(`${market.marketId}|${categoryId}`);
  }

  categoryExists(market: MarketContext, categoryId: Id<'Category'>) {
    return Promise.resolve(this.categories.has(`${market.marketId}|${categoryId}`));
  }

  find(market: MarketContext, categoryId: Id<'Category'>) {
    const state = this.rows.get(`${market.marketId}|${categoryId}`);
    return Promise.resolve(
      state === undefined
        ? CategoryOfferReviewFlags.none(market.marketId, categoryId)
        : CategoryOfferReviewFlags.restore(state),
    );
  }

  save(market: MarketContext, flags: CategoryOfferReviewFlags, expectedVersion: number) {
    const k = `${market.marketId}|${flags.state.categoryId}`;
    const stored = this.rows.get(k);
    const current = stored?.version ?? 0;
    if (this.loseNextSave || current !== expectedVersion) {
      this.loseNextSave = false;
      return Promise.resolve(false);
    }
    this.rows.set(k, { ...flags.state, version: current + 1 });
    return Promise.resolve(true);
  }

  appendChange(market: MarketContext, entry: CategoryOfferReviewChangeEntry) {
    this.changes.push({ ...entry, marketId: market.marketId });
    return Promise.resolve();
  }

  listFlagged(market: MarketContext) {
    if (this.failReads) return Promise.reject(new Error('flags down'));
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.marketId === market.marketId)
        .filter((row) => row.alwaysReview.on || row.reviewStop.on)
        .map((row) => ({
          categoryId: row.categoryId,
          alwaysReview: row.alwaysReview.on,
          reviewStop: row.reviewStop.on,
          version: row.version,
          alwaysReviewChangedAt: row.alwaysReview.changedAt,
          reviewStopChangedAt: row.reviewStop.changedAt,
        })),
    );
  }

  publishedCategoryIds(market: MarketContext, productId: Id<'Product'>) {
    return Promise.resolve(this.published.get(`${market.marketId}|${productId}`) ?? []);
  }
}
