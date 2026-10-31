import type { Id, Money, Temporal } from '@mondapac/shared-kernel';

// The seller ledger (Phase 5 package 5, reversals in package 6a): insert-only money rows, one per
// fact, never changed or deleted. A seller's balance is the sum of its credits less its debits and
// may be negative (a refund after the money was counted). Stripe fees are the platform's (Q8) and
// never appear here; payouts add their own kinds.

/**
 * `sale`: the goods of an order line (credit). `shipping`: the seller order's flat fee (credit).
 * `commission`: the platform's commission on an order line (debit).
 *
 * Reversals after an admin refund, in the same basis as the row they reverse: `refund-sale` and
 * `refund-shipping` (debits), `refund-commission` (credit: the platform gives the commission on the
 * refunded part back). `dispute-debit` (debit) and `dispute-reinstate` (credit) are reserved for
 * the disputes package: the database allows them, nothing writes them yet.
 */
export type LedgerKind =
  | 'sale'
  | 'shipping'
  | 'commission'
  | 'refund-sale'
  | 'refund-shipping'
  | 'refund-commission'
  | 'dispute-debit'
  | 'dispute-reinstate';

export const LEDGER_KINDS: readonly LedgerKind[] = [
  'sale',
  'shipping',
  'commission',
  'refund-sale',
  'refund-shipping',
  'refund-commission',
  'dispute-debit',
  'dispute-reinstate',
];

/** The kinds written when a seller order is paid; they carry no source id. */
export const ORIGINAL_KINDS: readonly LedgerKind[] = ['sale', 'shipping', 'commission'];

const DEBITS: ReadonlySet<LedgerKind> = new Set([
  'commission',
  'refund-sale',
  'refund-shipping',
  'dispute-debit',
]);

/** Credits add to the seller's balance, debits take from it. */
export const isCredit = (kind: LedgerKind): boolean => !DEBITS.has(kind);

export interface LedgerEntry {
  readonly id: Id<'LedgerEntry'>;
  readonly sellerId: Id<'Seller'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  /** The order line; null for `shipping`, `refund-shipping` and the dispute kinds. */
  readonly orderLineId: Id<'OrderLine'> | null;
  readonly kind: LedgerKind;
  /** Never negative; the kind says whether it is a credit or a debit. */
  readonly amount: Money;
  /** `commission` and `refund-commission` only: the frozen rate and the base it applies to. */
  readonly rateBps: number | null;
  readonly baseAmount: bigint | null;
  /** The refund (or dispute) a reversal comes from; null for the three original kinds. */
  readonly sourceId: Id<'Refund'> | Id<'Dispute'> | null;
  /** When the fact happened (the payment confirmed the order; for a reversal, the refund settled). */
  readonly occurredAt: Temporal.Instant;
  readonly recordedAt: Temporal.Instant;
}

/** What one seller holds in the ledger, in one currency. */
export interface LedgerTotals {
  readonly sales: bigint;
  readonly shipping: bigint;
  readonly commission: bigint;
  /** Sale goods given back by refunds. */
  readonly refundedSales: bigint;
  /** Shipping fees given back by refunds. */
  readonly refundedShipping: bigint;
  /** Commission given back to the seller on refunded goods (a credit). */
  readonly refundedCommission: bigint;
  readonly disputeDebits: bigint;
  readonly disputeReinstated: bigint;
  /**
   * sales + shipping − commission − refunded sales − refunded shipping + refunded commission −
   * dispute debits + dispute reinstated. May be negative.
   */
  readonly balance: bigint;
}

export function totalsOf(sums: Readonly<Partial<Record<LedgerKind, bigint>>>): LedgerTotals {
  const sales = sums.sale ?? 0n;
  const shipping = sums.shipping ?? 0n;
  const commission = sums.commission ?? 0n;
  const refundedSales = sums['refund-sale'] ?? 0n;
  const refundedShipping = sums['refund-shipping'] ?? 0n;
  const refundedCommission = sums['refund-commission'] ?? 0n;
  const disputeDebits = sums['dispute-debit'] ?? 0n;
  const disputeReinstated = sums['dispute-reinstate'] ?? 0n;
  return {
    sales,
    shipping,
    commission,
    refundedSales,
    refundedShipping,
    refundedCommission,
    disputeDebits,
    disputeReinstated,
    balance:
      sales +
      shipping -
      commission -
      refundedSales -
      refundedShipping +
      refundedCommission -
      disputeDebits +
      disputeReinstated,
  };
}

/**
 * What each seller order of one seller is worth now in `currency`: its credits less its debits.
 * The pure form of `LedgerRepository.netBySellerOrder` (the repository sums in the database).
 */
export function netBySellerOrder(
  entries: readonly LedgerEntry[],
  sellerId: Id<'Seller'>,
  currency: string,
): readonly { readonly sellerOrderId: Id<'SellerOrder'>; readonly net: bigint }[] {
  const nets = new Map<Id<'SellerOrder'>, bigint>();
  for (const entry of entries) {
    if (entry.sellerId !== sellerId || entry.amount.currency !== currency) continue;
    const signed = isCredit(entry.kind) ? entry.amount.amount : -entry.amount.amount;
    nets.set(entry.sellerOrderId, (nets.get(entry.sellerOrderId) ?? 0n) + signed);
  }
  return [...nets].map(([sellerOrderId, net]) => ({ sellerOrderId, net }));
}
