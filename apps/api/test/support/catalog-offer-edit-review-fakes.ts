import type {
  AuditEntry,
  CallContext,
  Id,
  IdGenerator,
  MarketContext,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type { PrismaService } from '../../src/platform/persistence/prisma.service';
import { OfferEditReview } from '../../src/modules/catalog/application/offer-edit-review';
import type { OfferPendingChangeRepository } from '../../src/modules/catalog/application/ports/offer-pending-change.repository';
import type {
  OfferReviewReferral,
  OfferReviewReferralStore,
  OfferReviewSettings,
} from '../../src/modules/catalog/application/ports/offer-review';
import {
  OfferPendingChange,
  type OfferPendingChangeState,
} from '../../src/modules/catalog/domain/offer-pending-change';
import { PrismaOfferPendingChangeRepository } from '../../src/modules/catalog/infrastructure/prisma-offer-pending-change.repository';
import { PrismaOfferReviewReferralStore } from '../../src/modules/catalog/infrastructure/prisma-offer-review-referral.store';

/**
 * The review settings of the specs written before slice 2c: mode `off` holds nothing, so every
 * edit of a live Offer applies at once as it did (an `edit` referral with no reason is recorded).
 */
export const REVIEW_OFF: OfferReviewSettings = Object.freeze({
  mode: 'off',
  certificateBadges: 'automatic',
  emergencyStop: false,
});

/**
 * The held changes of Offers in memory, with the rules of the table (one open per Offer) and the
 * Market filter of every read, as the Prisma repository has it.
 */
export class InMemoryOfferPendingChanges implements OfferPendingChangeRepository {
  readonly rows = new Map<string, OfferPendingChangeState>();
  /** Every statement checks it runs in a unit when set. */
  inUnit: (() => boolean) | null = null;

  #assertUnit(): void {
    if (this.inUnit !== null && !this.inUnit()) throw new Error('pending changes outside a unit');
  }

  insert(_market: MarketContext, change: OfferPendingChange): Promise<void> {
    this.#assertUnit();
    const state = change.state;
    const open = [...this.rows.values()].some(
      (row) => row.offerId === state.offerId && row.status === 'pending',
    );
    if (open) throw new StaleAggregateError('offer-pending-change', state.offerId);
    this.rows.set(state.id, state);
    return Promise.resolve();
  }

  decide(_market: MarketContext, change: OfferPendingChange): Promise<boolean> {
    this.#assertUnit();
    const stored = this.rows.get(change.state.id);
    if (stored?.status !== 'pending') return Promise.resolve(false);
    this.rows.set(change.state.id, change.state);
    return Promise.resolve(true);
  }

  findOpenByOffer(market: MarketContext, offerId: Id<'Offer'>) {
    const row = [...this.rows.values()].find(
      (state) =>
        state.marketId === market.marketId &&
        state.offerId === offerId &&
        state.status === 'pending',
    );
    return Promise.resolve(row === undefined ? null : OfferPendingChange.restore(row));
  }

  findLatestByOffer(market: MarketContext, offerId: Id<'Offer'>) {
    const rows = [...this.rows.values()].filter(
      (state) => state.marketId === market.marketId && state.offerId === offerId,
    );
    const row = rows[rows.length - 1];
    return Promise.resolve(row === undefined ? null : OfferPendingChange.restore(row));
  }

  findById(market: MarketContext, id: Id<'OfferPendingChange'>) {
    const row = this.rows.get(id);
    return Promise.resolve(
      row === undefined || row.marketId !== market.marketId
        ? null
        : OfferPendingChange.restore(row),
    );
  }

  listPending(
    market: MarketContext,
    page: {
      readonly after: { readonly submittedAt: Temporal.Instant; readonly id: string } | null;
      readonly limit: number;
    },
  ) {
    const after = page.after;
    const rows = [...this.rows.values()]
      .filter((row) => row.marketId === market.marketId && row.status === 'pending')
      .sort((a, b) =>
        a.submittedAt.epochNanoseconds === b.submittedAt.epochNanoseconds
          ? a.id.localeCompare(b.id)
          : a.submittedAt.epochNanoseconds < b.submittedAt.epochNanoseconds
            ? -1
            : 1,
      )
      .filter(
        (row) =>
          after === null ||
          row.submittedAt.epochNanoseconds > after.submittedAt.epochNanoseconds ||
          (row.submittedAt.epochNanoseconds === after.submittedAt.epochNanoseconds &&
            row.id > after.id),
      )
      .slice(0, page.limit);
    return Promise.resolve(rows.map((row) => OfferPendingChange.restore(row)));
  }
}

/** An {@link OfferEditReview} over memory, recording referrals and audit rows. */
export function memoryOfferEditReview(options: {
  readonly ids: IdGenerator;
  /** The Market's settings; 'fail' rejects the read (the review must fail closed). */
  readonly settings?: OfferReviewSettings | 'fail' | (() => OfferReviewSettings | 'fail');
  readonly pendingChanges?: InMemoryOfferPendingChanges;
  /** When given, every write must run inside a unit. */
  readonly inUnit?: () => boolean;
}) {
  const pendingChanges = options.pendingChanges ?? new InMemoryOfferPendingChanges();
  if (options.inUnit !== undefined) pendingChanges.inUnit = options.inUnit;
  const referrals: OfferReviewReferral[] = [];
  const audits: AuditEntry[] = [];
  let settingsReads = 0;
  const audit: AuditWriter = {
    record: (_context: CallContext, entry: AuditEntry) => {
      if (options.inUnit !== undefined && !options.inUnit())
        throw new Error('audit outside a unit');
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const store: OfferReviewReferralStore = {
    record: (_market, referral) => {
      if (options.inUnit !== undefined && !options.inUnit()) {
        throw new Error('referral outside a unit');
      }
      referrals.push(referral);
      return Promise.resolve();
    },
  };
  const review = new OfferEditReview({
    inputs: {
      settings: () => {
        settingsReads += 1;
        const value =
          typeof options.settings === 'function'
            ? options.settings()
            : (options.settings ?? REVIEW_OFF);
        return value === 'fail'
          ? Promise.reject(new Error('settings down'))
          : Promise.resolve(value);
      },
    },
    referrals: store,
    pendingChanges,
    audit,
    ids: options.ids,
  });
  return {
    review,
    pendingChanges,
    referrals,
    audits,
    settingsReads: () => settingsReads,
  };
}

/** An {@link OfferEditReview} over the database (db specs), with a given settings answer. */
export function prismaOfferEditReview(
  prisma: PrismaService,
  ids: IdGenerator,
  audit: AuditWriter,
  settings: OfferReviewSettings = REVIEW_OFF,
): OfferEditReview {
  return new OfferEditReview({
    inputs: { settings: () => Promise.resolve(settings) },
    referrals: new PrismaOfferReviewReferralStore(prisma, ids),
    pendingChanges: new PrismaOfferPendingChangeRepository(prisma),
    audit,
    ids,
  });
}

/** An audit writer that keeps nothing (db specs that do not read the audit). */
export const NO_AUDIT: AuditWriter = { record: () => Promise.resolve() };
