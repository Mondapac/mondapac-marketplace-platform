import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OrderState, OrderStatus } from '../../domain/order';

/** Newest first; the cursor is the last row of the previous page. */
export interface OrderPage {
  readonly limit: number;
  readonly after: { readonly createdAt: Temporal.Instant; readonly id: Id<'Order'> } | null;
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

  listOwn(
    market: MarketContext,
    accountId: Id<'Account'>,
    page: OrderPage,
  ): Promise<readonly OrderState[]>;

  listAll(
    market: MarketContext,
    filter: { readonly status: OrderStatus | null },
    page: OrderPage,
  ): Promise<readonly OrderState[]>;

  /**
   * Writes the mutable columns (status, reason, payment state, Stripe ids, times) under the
   * version the order was read at and raises it. `stale` writes nothing.
   */
  save(market: MarketContext, order: OrderState): Promise<'saved' | 'stale'>;
}

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
