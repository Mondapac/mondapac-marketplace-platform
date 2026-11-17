import type { Id, MarketContext, Money, Temporal } from '@mondapac/shared-kernel';
import type { OrderStatus, PaymentState } from '../../domain/order';

/**
 * One order's payment as the customer page's Payments section shows it (customers management
 * phase 2b, gap c): the order, its state and payment state, the amount, the provider's payment id
 * (Stripe's PaymentIntent id; null before one exists) and when. Nothing else of the provider: no
 * Checkout session id, no idempotency key, no card data.
 */
export interface CustomerPaymentFact {
  readonly orderId: Id<'Order'>;
  readonly status: OrderStatus;
  readonly paymentState: PaymentState;
  readonly amount: Money;
  readonly providerPaymentId: string | null;
  readonly createdAt: Temporal.Instant;
  readonly confirmedAt: Temporal.Instant | null;
}

export interface CustomerPaymentsQuery {
  readonly accountId: Id<'Account'>;
  readonly paymentStates: readonly PaymentState[] | null;
  readonly statuses: readonly OrderStatus[] | null;
  /** Created at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
}

export type CustomerPaymentsSort = 'created' | 'amount';

/**
 * The reads of one customer's orders as payments, over `ordering.orders` (index
 * `orders_market_id_account_id_created_at_idx`). Each runs in the caller's unit, scoped by Market.
 */
export interface CustomerPaymentsReader {
  page(
    market: MarketContext,
    query: CustomerPaymentsQuery,
    order: { readonly sort: CustomerPaymentsSort; readonly direction: 'asc' | 'desc' },
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly CustomerPaymentFact[]>;

  count(market: MarketContext, query: CustomerPaymentsQuery): Promise<number>;

  /** What the customer paid: the captured orders' totals, one sum per currency (minor units). */
  paidTotals(market: MarketContext, accountId: Id<'Account'>): Promise<readonly Money[]>;

  /** The ids of the customer's orders, newest first, at most `limit`. */
  orderIds(
    market: MarketContext,
    accountId: Id<'Account'>,
    limit: number,
  ): Promise<readonly Id<'Order'>[]>;
}

export const CUSTOMER_PAYMENTS_READER = Symbol('CUSTOMER_PAYMENTS_READER');
