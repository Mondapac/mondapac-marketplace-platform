// The admin Invoices list: the answer of GET ordering/admin/documents (apps/api
// admin-document-list.dto.ts) and the list's own state. The rows are order confirmations and
// credit notes, one kind per tab. They are NOT tax invoices and have no number.

import type { OrderCustomer, Money } from '../../orders/types.ts';
import { isDatePreset, type DatePreset } from '../date-presets.ts';

export const VIEW_PERMISSION = 'ordering.order.view';

/** The two tabs, which are the two kinds the API lists (one at a time: no All tab). */
export const TABS = ['order-confirmation', 'credit-note'] as const;
export type Tab = (typeof TABS)[number];

export const SORTS = ['issued', 'amount'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** Issued starts newest first, and so does the amount (highest first). */
export const defaultDirection = (): Direction => 'desc';

/** The row actions the API names; one it does not know is ignored. */
export const ROW_ACTIONS = ['view-order', 'download-order-document'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface DocumentRow {
  readonly kind: string;
  /** The seller order id of a confirmation; the credit note id of a credit note. */
  readonly documentId: string;
  /** Always null until numbered tax invoices exist; never shown. */
  readonly documentNumber: null;
  readonly orderId: string;
  readonly sellerOrderId: string;
  readonly sellerId: string;
  /** Seller text. */
  readonly storeName: string | null;
  readonly accountId: string;
  /** Personal data; null without the customer key or when the lookup failed. */
  readonly customer: OrderCustomer | null;
  readonly issuedAt: string;
  /** Tax included. */
  readonly total: Money;
  /** The tax inside `total`; null when a line was placed before its tax was recorded. */
  readonly tax: Money | null;
  /** The delivery fee as paid, or the shipping refunded; tax included. */
  readonly shipping: Money;
  /** Credit notes only. */
  readonly refundId: string | null;
  readonly refundReason: string | null;
  readonly actions: readonly string[];
}

export interface DocumentCounts {
  readonly orderConfirmations: number;
  readonly creditNotes: number;
}

export interface DocumentsPage {
  readonly documents: readonly DocumentRow[];
  readonly counts: DocumentCounts;
  /** Null on a Previous and next page. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
  readonly searchCapped: boolean;
  readonly searchScope: 'customers-and-stores' | 'stores' | null;
}

export const tabCount = (counts: DocumentCounts, tab: Tab): number =>
  tab === 'order-confirmation' ? counts.orderConfirmations : counts.creditNotes;

export const FILTER_FIELDS = ['issued'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** The conditions of the filter panel. */
export interface Filters {
  readonly issued?: DatePreset;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

/** The filters a panel answer holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const issued = values['issued'];
  return isDatePreset(issued) ? { issued } : {};
}

export interface Query {
  readonly tab: Tab;
  /** What was typed, trimmed. */
  readonly q: string;
  readonly filters: Filters;
  /** One seller's documents, from a link (`?sellerId=`); the panel has no picker for it. */
  readonly sellerId: string | null;
  readonly sort: Sort;
  readonly direction: Direction;
  /** Page numbers: the page from 1. Previous and next ignores it (the cursor stack leads). */
  readonly page: number;
  /** Previous and next: the cursor that opened each page after the first. */
  readonly cursors: readonly string[];
}

export const DEFAULT_QUERY: Query = {
  tab: 'order-confirmation',
  q: '',
  filters: {},
  sellerId: null,
  sort: 'issued',
  direction: 'desc',
  page: 1,
  cursors: [],
};
