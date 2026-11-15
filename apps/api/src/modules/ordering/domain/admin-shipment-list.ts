import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { DeliveryAttention, DeliveryMethod } from './delivery-method';
import type { Fulfilment } from './order';
import type { OrderCustomerView } from './order-views';

// The admin Shipments list (panel menu v2, Sales > Shipments; a super list, CLAUDE.md rule 14):
// one row per seller order of a paid order, with how it travels and where it stands. It only reads
// `ordering.seller_orders` and its order; it never changes a seller order. The carrier's own
// progress lives in `shipping` and is not read here.

/**
 * Where a shipment stands, as the list's tabs show it: `to-prepare` (paid, not ready), `ready`
 * (ready, not handed over), `shipped`, `delivered`. Delivery attention is its own filter.
 */
export const SHIPMENT_STAGES = ['to-prepare', 'ready', 'shipped', 'delivered'] as const;
export type ShipmentStage = (typeof SHIPMENT_STAGES)[number];

export const SHIPMENT_ROW_ACTIONS = ['view-order', 'copy-tracking-reference'] as const;
export type ShipmentRowAction = (typeof SHIPMENT_ROW_ACTIONS)[number];

export const SHIPMENT_SORT_KEYS = ['paid', 'shipped', 'delivered', 'total'] as const;
export type ShipmentSortKey = (typeof SHIPMENT_SORT_KEYS)[number];

export interface ShipmentSort {
  readonly key: ShipmentSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Every field is an AND; null leaves it out. */
export interface ShipmentListFilter {
  readonly stage: ShipmentStage | null;
  /** A seller order id or an order id, exact. */
  readonly reference: string | null;
  /** A tracking reference the seller typed, exact. */
  readonly trackingRef: string | null;
  readonly deliveryMethod: DeliveryMethod | null;
  /** `any`: every seller order that needs an admin; or one attention code. */
  readonly attention: DeliveryAttention | 'any' | null;
  /** The fleet quoted at placement (shipping's fleet code). */
  readonly fleet: string | null;
  readonly sellerId: Id<'Seller'> | null;
  /** Paid at or after `paidFrom`, before `paidTo`. */
  readonly paidFrom: Temporal.Instant | null;
  readonly paidTo: Temporal.Instant | null;
  /** Shipped at or after `shippedFrom`, before `shippedTo`. */
  readonly shippedFrom: Temporal.Instant | null;
  readonly shippedTo: Temporal.Instant | null;
  readonly parties: {
    readonly accountIds: readonly Id<'Account'>[];
    readonly sellerIds: readonly Id<'Seller'>[];
  } | null;
}

export interface ShipmentListRecord {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderId: Id<'Order'>;
  readonly sellerId: Id<'Seller'>;
  readonly accountId: Id<'Account'>;
  readonly paidAt: Temporal.Instant;
  readonly deliveryMethod: DeliveryMethod;
  readonly deliveryWindow: {
    readonly start: Temporal.Instant;
    readonly end: Temporal.Instant;
  } | null;
  readonly fulfilment: Fulfilment;
  readonly readyAt: Temporal.Instant | null;
  readonly shippedAt: Temporal.Instant | null;
  readonly deliveredAt: Temporal.Instant | null;
  /** The carrier the seller named when shipping, and its tracking reference. */
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  /** The fleet quoted at placement; null for a pickup and older orders. */
  readonly fleet: string | null;
  readonly deliveryAttention: DeliveryAttention | null;
  /** What the buyer paid for delivery, and the seller order's total. */
  readonly shipping: Money;
  readonly total: Money;
  /** The gross of the refunds not failed. */
  readonly refunded: Money;
}

export interface ShipmentStageCounts {
  readonly toPrepare: number;
  readonly ready: number;
  readonly shipped: number;
  readonly delivered: number;
  /** Seller orders of paid orders that need an admin (any stage). */
  readonly attention: number;
}

export interface ShipmentListRow extends ShipmentListRecord {
  readonly stage: ShipmentStage;
  readonly storeName: string | null;
  /** PERSONAL DATA; null without the customer key or when the lookup failed. */
  readonly customer: OrderCustomerView | null;
  readonly actions: readonly ShipmentRowAction[];
}

export interface ShipmentListPage {
  readonly rows: readonly ShipmentListRow[];
  readonly counts: ShipmentStageCounts;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly searchCapped: boolean;
  readonly searchScope: 'customers-and-stores' | 'stores' | null;
}

export function shipmentStage(record: ShipmentListRecord): ShipmentStage {
  if (record.fulfilment === 'delivered') return 'delivered';
  if (record.fulfilment === 'shipped') return 'shipped';
  return record.readyAt === null ? 'to-prepare' : 'ready';
}

/**
 * The row actions of one shipment. Opening the order needs the same view key as the list; the
 * tracking reference exists only once the seller typed one. Delivery changes stay with the seller
 * and the carrier: an admin has no shipment action here.
 */
export function shipmentRowActions(record: ShipmentListRecord): readonly ShipmentRowAction[] {
  const actions: ShipmentRowAction[] = ['view-order'];
  if (record.trackingRef !== null) actions.push('copy-tracking-reference');
  return actions;
}
