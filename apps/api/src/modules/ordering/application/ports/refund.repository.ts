import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { LedgerState } from '../../domain/order';
import type { Refund, RefundTarget } from '../../domain/refund';
import type { RefundLimit, RefundUsage } from '../../domain/refund-limits';

/** A pending refund with the PaymentIntent it gives money back from. */
export interface PendingRefund {
  readonly refund: Refund;
  readonly paymentIntentId: string;
}

/** A succeeded refund not yet in the seller ledger, with what the ledger step needs beside it. */
export interface RefundForLedger {
  readonly refund: Refund;
  /** Whether the seller order's own paid facts are in the ledger (a refund waits for them). */
  readonly sellerOrderLedgerState: LedgerState;
  /** What the customer paid for delivery on the seller order, tax included; null if unknown. */
  readonly shippingCharge: bigint | null;
  /** Order lines of the seller order whose amount after discounts is 0: they wrote no ledger rows. */
  readonly freeLines: ReadonlySet<Id<'OrderLine'>>;
}

/** The credit note written with a successful refund (once; never changed). */
export interface CreditNoteRecord {
  readonly id: Id<'CreditNote'>;
  readonly issuedAt: Temporal.Instant;
}

/** The caps an admin set: the seller's own (null when none or not asked) and the default. */
export interface RefundLimits {
  readonly own: RefundLimit | null;
  readonly marketDefault: RefundLimit | null;
}

/** What a seller refund is checked against, read under the seller's guard lock. */
export interface SellerRefundGuard extends RefundLimits {
  readonly usage: RefundUsage;
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
   * Every refund of the order's seller orders (any state), oldest first, each with its credit note
   * id when it succeeded. Empty for an unknown or another Market's order.
   */
  listForOrder(
    market: MarketContext,
    orderId: Id<'Order'>,
  ): Promise<
    readonly { readonly refund: Refund; readonly creditNoteId: Id<'CreditNote'> | null }[]
  >;

  /**
   * The seller's own seller order with what earlier refunds gave back, or null: another shop's
   * seller order answers exactly as an unknown one (the seller route names only its id).
   */
  findSellerTarget(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    sellerId: Id<'Seller'>,
  ): Promise<RefundTarget | null>;

  /** One refund of the Market by id, any state, or null (unknown and foreign are one answer). */
  findById(market: MarketContext, refundId: Id<'Refund'>): Promise<Refund | null>;

  /**
   * Every refund of the seller's own seller order (any state), oldest first, for its page; none
   * for another shop's seller order (Hassan, row 40 F4).
   */
  listOfSellerOrder(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    sellerId: Id<'Seller'>,
  ): Promise<readonly Refund[]>;

  /**
   * Raises the seller order's refunded sum by the refund's gross only if it still is
   * `expectedRefunded` and the order is still confirmed and captured (Hassan L4), then inserts
   * the refund with its lines. `stale` writes nothing, also when another refund of the seller
   * order became pending meanwhile (the one-pending index; Hassan L3). With `whileNotReady` (a
   * seller's unavailable units) the seller order must also still be to ship and not ready, under
   * the same row lock, so a ready signal racing the request never lets both through.
   */
  reserve(
    market: MarketContext,
    refund: Refund,
    expectedRefunded: bigint,
    options?: { readonly whileNotReady?: boolean },
  ): Promise<'saved' | 'stale'>;

  /**
   * Takes the seller's refund guard row (made on first use) with a row lock held until the unit
   * ends, so two seller refunds of one seller are counted one after the other; then answers the
   * caps in the Market (the seller's own and the default) and the seller's own refunds not failed
   * requested after `since` (count and gross sum). Call it in the unit that reserves the refund.
   */
  guardSellerRefunds(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
    since: Temporal.Instant,
  ): Promise<SellerRefundGuard>;

  /**
   * Notes an admin alert for the seller unless one was noted after `since`: the alert number (the
   * event's aggregate version) when this unit is the one to send it, else null.
   */
  noteRefundLimitAlert(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
    since: Temporal.Instant,
  ): Promise<number | null>;

  /** The Market's default cap and, when `sellerId` is given, that seller's own. */
  findRefundLimits(market: MarketContext, sellerId: Id<'Seller'> | null): Promise<RefundLimits>;

  /**
   * Writes a cap: a first one (with `limit.id`) when `expectedVersion` is 0 (`stale` when one
   * exists already), else the stored one only if it still has that version (then version + 1).
   */
  saveRefundLimit(
    market: MarketContext,
    limit: RefundLimit,
    expectedVersion: number,
  ): Promise<'saved' | 'stale'>;

  /** Removes a seller's own cap if it still has that version; `stale` otherwise (or none). */
  removeRefundLimit(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    expectedVersion: number,
  ): Promise<'removed' | 'stale'>;

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
   * Succeeded refunds not yet in the seller ledger, whose seller order is not still waiting for its
   * own paid facts (those wait): fewest refused first, then oldest, so a refund the ledger keeps
   * refusing never blocks the ones behind it.
   */
  findUnrecordedLedger(market: MarketContext, limit: number): Promise<readonly RefundForLedger[]>;

  /** Counts one more refused attempt to write the refund into the ledger; answers the count. */
  countLedgerFailure(market: MarketContext, refundId: Id<'Refund'>): Promise<number>;

  /** Marks the refund as handled by the ledger step (once; a second call changes nothing). */
  markLedgerRecorded(
    market: MarketContext,
    refundId: Id<'Refund'>,
    at: Temporal.Instant,
  ): Promise<void>;

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
