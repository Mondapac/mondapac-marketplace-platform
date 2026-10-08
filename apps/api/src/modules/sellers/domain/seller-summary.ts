import type { Id } from '@mondapac/shared-kernel';

/** The operating zone of a seller as `sellerSummaries` gives it (sellers design 7.1). */
export interface SummaryTimezone {
  /** IANA id, never an offset (ADR-0005 decision 1). */
  readonly zone: string;
  /**
   * True while the zone is the draft's: no approved revision carries it yet, so a reviewer may
   * still change it. Before slice 5 there is no approved revision, so it is always true. A
   * caller that needs the zone of a certificate's claim reads `approvedSellerZones`, never this.
   */
  readonly provisional: boolean;
}

/**
 * One answer of `sellerSummaries` (sellers design 7.1). It knows whether the file exists and,
 * for a caller entitled to it, the draft's zone; the slug and the public store name join the
 * answer with the slices that create them.
 *
 * `operatingTimezone` is absent (the key is not there) when the seller has no zone yet, the file
 * does not exist, or the caller may not see a provisional zone (Hassan L4). An absent value
 * means "not known to this caller", never a default.
 */
export interface SellerSummary {
  readonly sellerId: Id<'Seller'>;
  readonly exists: boolean;
  readonly operatingTimezone?: SummaryTimezone;
}
