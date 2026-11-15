import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

// The "Email sellers" requests of the Missing details report (attributes package A4-4): one row per
// seller and product, the 7-day throttle and the queue the mail job reads. No address is stored.
// Every method runs in the caller's unit.

export type MissingDetailsEmailKey = {
  readonly sellerId: Id<'Seller'>;
  readonly productId: string;
};

/** What a request says, written when it is claimed. */
export interface MissingDetailsEmailDraft extends MissingDetailsEmailKey {
  readonly sellerName: string | null;
  readonly productName: string;
  readonly missingLabels: readonly string[];
}

/** The state of the last request for a seller and a product. */
export interface MissingDetailsEmailRecord extends MissingDetailsEmailKey {
  readonly state: 'pending' | 'sent' | 'skipped' | 'failed';
  readonly requestedAt: Temporal.Instant;
  /** When it settled (sent: when the mail went); null while pending. */
  readonly settledAt: Temporal.Instant | null;
}

/** A pending request, as the job reads it. */
export interface PendingMissingDetailsEmail extends MissingDetailsEmailDraft {
  readonly attempts: number;
  readonly requestedAt: Temporal.Instant;
}

export type MissingDetailsEmailEnd =
  | { readonly state: 'sent'; readonly attempts: number }
  | {
      readonly state: 'skipped' | 'failed';
      readonly outcome: 'no-address' | 'send-failed';
      readonly attempts: number;
    };

export interface MissingDetailsEmailStore {
  /** The latest request for each pair; a pair never asked for is absent. */
  latest(
    market: MarketContext,
    pairs: readonly MissingDetailsEmailKey[],
  ): Promise<readonly MissingDetailsEmailRecord[]>;

  /**
   * Takes the pair for a request: inserts it, or replaces an earlier request that is older than
   * `notAfter` or that did not reach the seller (`skipped`, `failed`). False when the pair was
   * asked for more recently (nothing written). Two admins asking at once: one gets true.
   */
  claim(
    market: MarketContext,
    draft: MissingDetailsEmailDraft,
    claim: {
      readonly requestedBy: Id<'Account'>;
      readonly now: Temporal.Instant;
      readonly notAfter: Temporal.Instant;
    },
  ): Promise<boolean>;

  /** Pending requests, oldest first, at most `limit`. */
  pending(market: MarketContext, limit: number): Promise<readonly PendingMissingDetailsEmail[]>;

  /** Ends or retries a pending request. False when it was no longer pending. */
  settle(
    market: MarketContext,
    key: MissingDetailsEmailKey,
    end: MissingDetailsEmailEnd | { readonly state: 'pending'; readonly attempts: number },
    now: Temporal.Instant,
  ): Promise<boolean>;
}

export const MISSING_DETAILS_EMAIL_STORE = Symbol('CATALOG_MISSING_DETAILS_EMAIL_STORE');
