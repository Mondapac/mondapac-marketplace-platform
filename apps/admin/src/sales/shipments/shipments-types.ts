// The admin Shipments list: the answer of GET ordering/admin/shipments (apps/api
// admin-shipment-list.dto.ts) and the list's own state. One row per seller order of a paid order.

import type { OrderCustomer, Money } from '../../orders/types.ts';
import { isDatePreset, type DatePreset } from '../date-presets.ts';
import type { SearchScope } from './shipments-search.ts';

export const VIEW_PERMISSION = 'ordering.order.view';

export const STAGES = ['to-prepare', 'ready', 'shipped', 'delivered', 'refunded'] as const;
export type Stage = (typeof STAGES)[number];

/** The tabs: every shipment, those that need an admin, then one tab per stage. */
export const TABS = ['all', 'attention', ...STAGES] as const;
export type Tab = (typeof TABS)[number];

export const ATTENTIONS = ['any', 'no-carrier', 'carrier-unknown', 'cancel-unknown'] as const;
export type Attention = (typeof ATTENTIONS)[number];
export const DELIVERY_ATTENTIONS = ['no-carrier', 'carrier-unknown', 'cancel-unknown'] as const;

export const DELIVERY_METHODS = ['pickup', 'instant', 'same_day', 'scheduled'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const SORTS = ['paid', 'shipped', 'delivered', 'total'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Times start newest first, and so does the total (highest first). */
export const defaultDirection = (): Direction => 'desc';

/** The row actions the API names; one it does not know is ignored. */
export const ROW_ACTIONS = ['view-order', 'copy-tracking-reference'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export const CARRIER_PROGRESS = [
  'booked',
  'picked-up',
  'delivered',
  'exception',
  'cancelled',
] as const;

/** What the carrier booking reports (advisory; it can differ from the stage for a short time). */
export interface CarrierProgress {
  /** A value this panel does not know is shown as Unknown. */
  readonly progress: string;
  /** The carrier's own code, seller or carrier text. */
  readonly carrierStatus: string | null;
  readonly updatedAt: string;
  readonly proofOfDelivery: boolean;
  /** Seller text. */
  readonly fleet: string;
}

export interface ShipmentRow {
  readonly sellerOrderId: string;
  readonly orderId: string;
  readonly sellerId: string;
  /** Seller text. */
  readonly storeName: string | null;
  readonly accountId: string;
  /** Personal data; null without the customer key or when the lookup failed. */
  readonly customer: OrderCustomer | null;
  readonly paidAt: string;
  readonly deliveryMethod: string;
  readonly deliveryWindow: { readonly start: string; readonly end: string } | null;
  readonly stage: string;
  readonly fulfilment: string;
  readonly readyAt: string | null;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  /** Seller text. */
  readonly carrier: string | null;
  /** Seller text. */
  readonly trackingRef: string | null;
  readonly fleet: string | null;
  readonly deliveryAttention: string | null;
  /** Null when the order has no carrier booking. */
  readonly carrierProgress: CarrierProgress | null;
  readonly shipping: Money;
  readonly total: Money;
  readonly refunded: Money;
  readonly actions: readonly string[];
}

export interface ShipmentCounts {
  readonly toPrepare: number;
  readonly ready: number;
  readonly shipped: number;
  readonly delivered: number;
  readonly refunded: number;
  readonly attention: number;
}

export interface ShipmentsPage {
  readonly shipments: readonly ShipmentRow[];
  readonly counts: ShipmentCounts;
  /** False when the carrier progress of this page could not be loaded: every row's is unknown. */
  readonly carrierProgressAvailable: boolean;
  /** Null on a Previous and next page. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
  readonly searchCapped: boolean;
  readonly searchScope: 'customers-and-stores' | 'stores' | null;
}

/** The count a tab shows; All is the sum of the stages, which split the rows. */
export function tabCount(counts: ShipmentCounts, tab: Tab): number {
  switch (tab) {
    case 'all':
      return counts.toPrepare + counts.ready + counts.shipped + counts.delivered + counts.refunded;
    case 'attention':
      return counts.attention;
    case 'to-prepare':
      return counts.toPrepare;
    case 'ready':
      return counts.ready;
    case 'shipped':
      return counts.shipped;
    case 'delivered':
      return counts.delivered;
    case 'refunded':
      return counts.refunded;
  }
}

export const FILTER_FIELDS = ['deliveryMethod', 'attention', 'paid', 'shipped'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly deliveryMethod?: DeliveryMethod;
  readonly attention?: Attention;
  readonly paid?: DatePreset;
  readonly shipped?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const next: {
    deliveryMethod?: DeliveryMethod;
    attention?: Attention;
    paid?: DatePreset;
    shipped?: DatePreset;
  } = {};
  const method = DELIVERY_METHODS.find((value) => value === values['deliveryMethod']);
  if (method !== undefined) next.deliveryMethod = method;
  const attention = ATTENTIONS.find((value) => value === values['attention']);
  if (attention !== undefined) next.attention = attention;
  const paid = values['paid'];
  if (isDatePreset(paid)) next.paid = paid;
  const shipped = values['shipped'];
  if (isDatePreset(shipped)) next.shipped = shipped;
  return next;
}

/** "Any problem" is the Needs attention tab itself, so a filter of it there says nothing. */
export function filtersOnTab(filters: Filters, tab: Tab): Filters {
  if (tab !== 'attention' || filters.attention !== 'any') return filters;
  return Object.fromEntries(Object.entries(filters).filter(([field]) => field !== 'attention'));
}

export interface Query {
  readonly tab: Tab;
  /** What was typed, trimmed; the scope and its length decide what is sent. */
  readonly q: string;
  readonly scope: SearchScope;
  readonly filters: Filters;
  /** One seller's shipments, from a link (`?sellerId=`); the panel has no picker for it. */
  readonly sellerId: string | null;
  readonly sort: Sort;
  readonly direction: Direction;
  /** Page numbers: the page from 1. Previous and next ignores it (the cursor stack leads). */
  readonly page: number;
  /** Previous and next: the cursor that opened each page after the first. */
  readonly cursors: readonly string[];
}

export const DEFAULT_QUERY: Query = {
  tab: 'all',
  q: '',
  scope: 'name',
  filters: {},
  sellerId: null,
  sort: 'paid',
  direction: 'desc',
  page: 1,
  cursors: [],
};
