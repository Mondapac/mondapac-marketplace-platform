import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  Fulfilment,
  OrderLine,
  OrderState,
  OrderStatus,
  SellerOrder,
} from '../../domain/order';
import type { OrderStatusCounts, SellerOrderCounts } from '../../domain/order-views';

/** Newest first; the cursor is the last row of the previous page. */
export interface OrderPage {
  readonly limit: number;
  readonly after: { readonly createdAt: Temporal.Instant; readonly id: Id<'Order'> } | null;
}

/** The admin list's filters; null keeps every order. */
export interface OrderFilter {
  readonly status: OrderStatus | null;
  /** An order id or a seller order id, matched exactly. */
  readonly reference: string | null;
}

/** The seller list's filter; null keeps every paid seller order. */
export interface SellerOrderFilter {
  readonly fulfilment: Fulfilment | null;
}

/** A seller's page of paid seller orders, newest payment first. */
export interface SellerOrderPage {
  readonly limit: number;
  readonly after: { readonly confirmedAt: Temporal.Instant; readonly id: Id<'SellerOrder'> } | null;
}

/** One seller order with what the seller needs from its order; only paid orders are read. */
export interface SellerOrderRecord {
  readonly sellerOrder: SellerOrder;
  readonly orderId: Id<'Order'>;
  /** The customer's account, whose key seals {@link shipToSealed}. */
  readonly accountId: Id<'Account'>;
  /** The order's sealed delivery address; null on orders placed before it was recorded. */
  readonly shipToSealed: string | null;
  readonly currency: string;
  readonly confirmedAt: Temporal.Instant;
  readonly lines: readonly OrderLine[];
}

/**
 * The store of orders, seller orders and order lines (ordering.orders and its children). Every
 * method runs in the open unit of the use case, through the Market-scoped client.
 */
export interface OrderRepository {
  /** Inserts the order with its seller orders and lines. */
  insert(market: MarketContext, order: OrderState): Promise<void>;

  findById(market: MarketContext, orderId: Id<'Order'>): Promise<OrderState | null>;

  /** The account's own order, or null: unknown and foreign are one answer. */
  findOwn(
    market: MarketContext,
    orderId: Id<'Order'>,
    accountId: Id<'Account'>,
  ): Promise<OrderState | null>;

  /** The account's orders still waiting for payment (to supersede on a new checkout). */
  findPending(market: MarketContext, accountId: Id<'Account'>): Promise<readonly OrderState[]>;

  /**
   * What is still open for the account, for a decision that must not strand a customer (account
   * deletion): the orders waiting for payment, or paid and not yet delivered in every seller
   * order (cancelled orders and delivered ones are closed), and the refunds still pending.
   */
  countOpenOf(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<{ readonly openOrders: number; readonly pendingRefunds: number }>;

  listOwn(
    market: MarketContext,
    accountId: Id<'Account'>,
    page: OrderPage,
  ): Promise<readonly OrderState[]>;

  /**
   * The Market's orders, newest first. `status` keeps one status; `reference` keeps the order
   * whose id, or one of whose seller orders' ids, is exactly that id (the reference in the
   * order emails).
   */
  listAll(
    market: MarketContext,
    filter: OrderFilter,
    page: OrderPage,
  ): Promise<readonly OrderState[]>;

  /** The Market's orders per status (one grouped count). */
  countAll(market: MarketContext): Promise<OrderStatusCounts>;

  /**
   * Writes the mutable columns (status, reason, payment state, Stripe ids, times) under the
   * version the order was read at and raises it. `stale` writes nothing.
   */
  save(market: MarketContext, order: OrderState): Promise<'saved' | 'stale'>;

  /** The seller's paid seller orders (the order is `confirmed`), newest payment first. */
  listForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    filter: SellerOrderFilter,
    page: SellerOrderPage,
  ): Promise<readonly SellerOrderRecord[]>;

  /** The seller's paid seller orders per fulfilment step (one grouped count). */
  countForSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerOrderCounts>;

  /** The seller's own paid seller order, or null: unknown, foreign and unpaid are one answer. */
  findForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sellerOrderId: Id<'SellerOrder'>,
  ): Promise<SellerOrderRecord | null>;

  /**
   * The customer account behind each of the seller's own paid seller orders among `sellerOrderIds`
   * (the order notices' short customer name). Unknown, foreign and unpaid ids are absent.
   */
  customerAccountsForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ): Promise<ReadonlyMap<Id<'SellerOrder'>, Id<'Account'>>>;

  /**
   * Writes the fulfilment fields of one seller order only if it still stands at `from`; `stale`
   * writes nothing (a double click or a second tab).
   */
  saveFulfilment(
    market: MarketContext,
    sellerOrder: SellerOrder,
    from: Fulfilment,
  ): Promise<'saved' | 'stale'>;

  /**
   * Writes the ready time of one seller order only if it is still `to-ship` and not ready yet;
   * `stale` writes nothing (a double click, a second tab, or an order that has moved on).
   */
  saveReady(market: MarketContext, sellerOrder: SellerOrder): Promise<'saved' | 'stale'>;

  /**
   * Writes the platform-attention state of one seller order only if it is still `to-ship` with no
   * attention recorded; `stale` writes nothing.
   */
  saveAttention(market: MarketContext, sellerOrder: SellerOrder): Promise<'saved' | 'stale'>;

  /** Shipped or delivered seller orders whose lines inventory has not recorded yet. */
  findUnrecordedShipments(
    market: MarketContext,
    limit: number,
  ): Promise<readonly SellerOrderRecord[]>;

  /**
   * Paid seller orders not yet in the seller ledger: fewest failed attempts first, then oldest
   * payment, so a seller order the ledger keeps refusing never blocks the ones behind it.
   */
  findUnrecordedLedger(market: MarketContext, limit: number): Promise<readonly SellerOrderRecord[]>;

  /**
   * Counts one more refused attempt to write the seller order into the ledger and answers the
   * count now (0 when the seller order is no longer pending).
   */
  countLedgerFailure(market: MarketContext, sellerOrderId: Id<'SellerOrder'>): Promise<number>;

  /** Marks the seller order as written into the ledger (once; a second call changes nothing). */
  markLedgerRecorded(market: MarketContext, sellerOrderId: Id<'SellerOrder'>): Promise<void>;

  /** Marks the lines as recorded in inventory (once; a second call changes nothing). */
  markInventoryRecorded(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    at: Temporal.Instant,
  ): Promise<void>;
}

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
