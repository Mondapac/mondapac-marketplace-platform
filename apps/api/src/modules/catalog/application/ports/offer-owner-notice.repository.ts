import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

// The pending warnings to Offer owners (certification request C-6; CERT-45; certification slice
// 15; Hassan M1, Mojtaba N2; data design 3.27): the event handler writes one row per Owner in its
// inbox unit, the job sends each with its own marker and retry. No address is stored. Every
// method runs in the caller's unit.

/** One Owner to warn, as the handler found it. */
export interface OfferOwnerNoticeDraft {
  readonly id: Id<'OfferOwnerNotice'>;
  readonly sellerId: Id<'Seller'>;
  readonly typeCode: string;
  readonly offers: number;
  readonly validUntil: Temporal.Instant;
}

/** A pending notice that is due. */
export interface DueOfferOwnerNotice {
  readonly id: Id<'OfferOwnerNotice'>;
  readonly sellerId: Id<'Seller'>;
  readonly typeCode: string;
  readonly offers: number;
  readonly validUntil: Temporal.Instant;
  readonly attempts: number;
}

export type OfferOwnerNoticeOutcome = 'no-address' | 'past-validity' | 'send-failed';

export interface OfferOwnerNoticeRepository {
  /**
   * Writes the notices of one warning event; a second write of the same event and Owner is
   * ignored (`ON CONFLICT DO NOTHING`). Returns the rows written.
   */
  enqueue(
    market: MarketContext,
    batch: {
      readonly sourceEventId: Id;
      readonly productCertificationId: Id;
      readonly thresholdDays: number;
      readonly notices: readonly OfferOwnerNoticeDraft[];
      readonly now: Temporal.Instant;
    },
  ): Promise<number>;

  /** Pending notices due at `now`, earliest first (the claim index), at most `limit`. */
  due(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly DueOfferOwnerNotice[]>;

  /**
   * Ends a pending notice: `sent`, or `skipped` / `failed` with the outcome. False when it was no
   * longer pending (nothing written).
   */
  settle(
    market: MarketContext,
    id: Id<'OfferOwnerNotice'>,
    end:
      | { readonly state: 'sent'; readonly attempts: number }
      | {
          readonly state: 'skipped' | 'failed';
          readonly outcome: OfferOwnerNoticeOutcome;
          readonly attempts: number;
        },
    now: Temporal.Instant,
  ): Promise<boolean>;

  /** A failed send of a pending notice, tried again at `nextAttemptAt`. False when not pending. */
  defer(
    market: MarketContext,
    id: Id<'OfferOwnerNotice'>,
    retry: { readonly attempts: number; readonly nextAttemptAt: Temporal.Instant },
  ): Promise<boolean>;
}

export const OFFER_OWNER_NOTICES = Symbol('CATALOG_OFFER_OWNER_NOTICES');
