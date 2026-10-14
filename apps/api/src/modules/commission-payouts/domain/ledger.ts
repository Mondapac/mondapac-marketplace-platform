import type { Id, Money, Temporal } from '@mondapac/shared-kernel';

// The seller ledger (Phase 5 package 5): insert-only money rows, one per fact, never changed or
// deleted. A seller's balance is the sum of its credits less its debits. Stripe fees are the
// platform's (Q8) and never appear here; payouts (package 6) add their own kinds.

/** `sale`: the goods of an order line (credit). `shipping`: the seller order's flat fee (credit).
 * `commission`: the platform's commission on an order line (debit). */
export type LedgerKind = 'sale' | 'shipping' | 'commission';

export const LEDGER_KINDS: readonly LedgerKind[] = ['sale', 'shipping', 'commission'];

export const isCredit = (kind: LedgerKind): boolean => kind !== 'commission';

export interface LedgerEntry {
  readonly id: Id<'LedgerEntry'>;
  readonly sellerId: Id<'Seller'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  /** The order line; null for `shipping`. */
  readonly orderLineId: Id<'OrderLine'> | null;
  readonly kind: LedgerKind;
  /** Never negative; the kind says whether it is a credit or a debit. */
  readonly amount: Money;
  /** `commission` only: the frozen rate and the base it was taken on. */
  readonly rateBps: number | null;
  readonly baseAmount: bigint | null;
  /** When the fact happened (the payment confirmed the order). */
  readonly occurredAt: Temporal.Instant;
  readonly recordedAt: Temporal.Instant;
}

/** What one seller holds in the ledger, in one currency. */
export interface LedgerTotals {
  readonly sales: bigint;
  readonly shipping: bigint;
  readonly commission: bigint;
  /** sales + shipping − commission. */
  readonly balance: bigint;
}

export function totalsOf(sums: Readonly<Partial<Record<LedgerKind, bigint>>>): LedgerTotals {
  const sales = sums.sale ?? 0n;
  const shipping = sums.shipping ?? 0n;
  const commission = sums.commission ?? 0n;
  return { sales, shipping, commission, balance: sales + shipping - commission };
}
