// The admin Refunds list: the answer of GET ordering/admin/refunds (apps/api
// admin-refund-list.dto.ts) and the list's own state. One row per refund.

import type { OrderCustomer, Money } from '../../orders/types.ts';
import { isDatePreset, type DatePreset } from '../date-presets.ts';

export const VIEW_PERMISSION = 'ordering.order.view';

export const STATES = ['pending', 'succeeded', 'failed'] as const;
export type RefundState = (typeof STATES)[number];

/** The tabs: every refund, then one tab per state. */
export const TABS = ['all', ...STATES] as const;
export type Tab = (typeof TABS)[number];

export const REASONS = [
  'not-received',
  'damaged',
  'wrong-item',
  'not-as-described',
  'seller-cancelled',
  'item-unavailable',
  'other',
] as const;
export type Reason = (typeof REASONS)[number];

export const ACTORS = ['admin', 'seller'] as const;
export type Actor = (typeof ACTORS)[number];

export const LOSS_BEARERS = ['seller', 'platform'] as const;
export type LossBearer = (typeof LOSS_BEARERS)[number];

export const LOSS_REASONS = [
  'platform-error',
  'carrier-loss',
  'seller-unrecoverable',
  'fraud-loss',
  'goodwill',
  'other',
] as const;

export const LEDGERS = ['waiting', 'recorded'] as const;
export type Ledger = (typeof LEDGERS)[number];

export const SORTS = ['requested', 'settled', 'amount'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Times start newest first, and so does the amount (highest first). */
export const defaultDirection = (): Direction => 'desc';

/** The row actions the API names; one it does not know is ignored. */
export const ROW_ACTIONS = ['view-order', 'copy-stripe-reference'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface RefundRow {
  readonly refundId: string;
  readonly orderId: string;
  readonly sellerOrderId: string;
  readonly sellerId: string;
  /** Seller text. */
  readonly storeName: string | null;
  readonly accountId: string;
  /** Personal data; null without the customer key or when the lookup failed. */
  readonly customer: OrderCustomer | null;
  /** What goes back to the customer, tax included. */
  readonly gross: Money;
  readonly tax: Money;
  readonly shippingGross: Money;
  readonly reason: string;
  readonly actor: string;
  readonly state: string;
  readonly lossBearer: string;
  readonly lossReasonCode: string | null;
  readonly stripeRefundId: string | null;
  readonly requestedAt: string;
  readonly settledAt: string | null;
  readonly ledgerRecordedAt: string | null;
  readonly creditNoteId: string | null;
  readonly actions: readonly string[];
}

export interface RefundCounts {
  readonly pending: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface RefundsPage {
  readonly refunds: readonly RefundRow[];
  readonly counts: RefundCounts;
  /** Null on a Previous and next page. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
  readonly searchCapped: boolean;
  readonly searchScope: 'customers-and-stores' | 'stores' | null;
}

/** The count a tab shows; All is the sum of the states, which split the rows. */
export function tabCount(counts: RefundCounts, tab: Tab): number {
  switch (tab) {
    case 'all':
      return counts.pending + counts.succeeded + counts.failed;
    case 'pending':
      return counts.pending;
    case 'succeeded':
      return counts.succeeded;
    case 'failed':
      return counts.failed;
  }
}

export const FILTER_FIELDS = ['reason', 'actor', 'lossBearer', 'ledger', 'requested'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly reason?: Reason;
  readonly actor?: Actor;
  readonly lossBearer?: LossBearer;
  readonly ledger?: Ledger;
  readonly requested?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const next: {
    reason?: Reason;
    actor?: Actor;
    lossBearer?: LossBearer;
    ledger?: Ledger;
    requested?: DatePreset;
  } = {};
  const reason = REASONS.find((value) => value === values['reason']);
  if (reason !== undefined) next.reason = reason;
  const actor = ACTORS.find((value) => value === values['actor']);
  if (actor !== undefined) next.actor = actor;
  const bearer = LOSS_BEARERS.find((value) => value === values['lossBearer']);
  if (bearer !== undefined) next.lossBearer = bearer;
  const ledger = LEDGERS.find((value) => value === values['ledger']);
  if (ledger !== undefined) next.ledger = ledger;
  const requested = values['requested'];
  if (isDatePreset(requested)) next.requested = requested;
  return next;
}

export interface Query {
  readonly tab: Tab;
  /** What was typed, trimmed; its shape and length decide what is sent. */
  readonly q: string;
  readonly filters: Filters;
  /** One seller's refunds, from a link (`?sellerId=`); the panel has no picker for it. */
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
  filters: {},
  sellerId: null,
  sort: 'requested',
  direction: 'desc',
  page: 1,
  cursors: [],
};
