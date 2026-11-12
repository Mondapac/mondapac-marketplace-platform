import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  MissingDetailsEmail,
  RecentMissingDetailsEmail,
} from '../../domain/missing-details-email';

/**
 * The "Email sellers" emails of the Missing details report (attributes A4-4) in
 * `catalog.missing_details_emails` and `catalog.missing_details_email_products`. Every method runs
 * in the caller's unit, through the Market-scoped client, catalog tables only.
 */
export interface MissingDetailsEmailStore {
  /**
   * Stores a new pending email and its products. `email.pending` when the seller already has a
   * pending one (the partial unique index): the unit is then aborted and must end.
   */
  add(market: MarketContext, email: MissingDetailsEmail): Promise<'email.pending' | null>;

  /** The pending or sent emails naming these products that were requested after `since`. */
  recent(
    market: MarketContext,
    productIds: readonly string[],
    since: Temporal.Instant,
  ): Promise<readonly RecentMissingDetailsEmail[]>;

  /** Of these sellers, those with a pending email. */
  pendingSellers(market: MarketContext, sellerIds: readonly string[]): Promise<ReadonlySet<string>>;

  /** Per product, when an email naming it was last sent (products never emailed are absent). */
  lastEmailed(
    market: MarketContext,
    productIds: readonly string[],
  ): Promise<ReadonlyMap<string, Temporal.Instant>>;

  /** Pending emails due at `now`, oldest due first. */
  dueNotices(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly MissingDetailsEmail[]>;

  /** Stores a notice move (pending to the next state), at the version before it. */
  saveNotice(market: MarketContext, email: MissingDetailsEmail): Promise<void>;
}

export const MISSING_DETAILS_EMAIL_STORE = Symbol('CATALOG_MISSING_DETAILS_EMAIL_STORE');
