import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Refund, RefundTarget } from '../../domain/refund';

/** A pending refund with the PaymentIntent it gives money back from. */
export interface PendingRefund {
  readonly refund: Refund;
  readonly paymentIntentId: string;
}

/** The credit note written with a successful refund (once; never changed). */
export interface CreditNoteRecord {
  readonly id: Id<'CreditNote'>;
  readonly issuedAt: Temporal.Instant;
}

/**
 * The refunds of seller orders (ordering.refunds, refund_lines, credit_notes) and the refunded
 * running sum on the seller order. Every method runs in the open unit of the use case, through
 * the Market-scoped client.
 */
export interface RefundRepository {
  /**
   * A paid or unpaid seller order of that order with what earlier refunds gave back, or null
   * (the admin route names both ids; unknown and foreign are one answer).
   */
  findTarget(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    orderId: Id<'Order'>,
  ): Promise<RefundTarget | null>;

  /**
   * Raises the seller order's refunded sum by the refund's gross only if it still is
   * `expectedRefunded` and the order is still confirmed and captured (Hassan L4), then inserts
   * the refund with its lines. `stale` writes nothing, also when another refund of the seller
   * order became pending meanwhile (the one-pending index; Hassan L3).
   */
  reserve(
    market: MarketContext,
    refund: Refund,
    expectedRefunded: bigint,
  ): Promise<'saved' | 'stale'>;

  /**
   * Marks a pending refund succeeded and writes its credit note. False when it was no longer
   * pending (another run settled it): nothing is written.
   */
  markSucceeded(
    market: MarketContext,
    refund: Refund,
    stripeRefundId: string,
    creditNote: CreditNoteRecord,
  ): Promise<boolean>;

  /**
   * Marks a pending refund failed (with Stripe's refund id when Stripe made one that failed) and
   * lowers the seller order's refunded sum by its gross. False when it was no longer pending.
   */
  markFailed(
    market: MarketContext,
    refund: Refund,
    at: Temporal.Instant,
    stripeRefundId: string | null,
  ): Promise<boolean>;

  /**
   * Counts one more Stripe call whose answer was not final, and keeps Stripe's refund id when
   * Stripe made one that is still pending (it is then read back by id, never made again).
   */
  countAttempt(market: MarketContext, refund: Refund, stripeRefundId: string | null): Promise<void>;

  /**
   * Pending refunds asked for before `window.before`, oldest first: those Stripe made (read back
   * by id) at any age, the others only after `window.after` (while Stripe keeps their key).
   */
  findPending(
    market: MarketContext,
    window: { readonly after: Temporal.Instant; readonly before: Temporal.Instant },
    limit: number,
  ): Promise<readonly PendingRefund[]>;
}

export const REFUND_REPOSITORY = Symbol('REFUND_REPOSITORY');
