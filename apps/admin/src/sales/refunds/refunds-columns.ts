// The columns of the Refunds list. Order and State are always shown; these are the ones an admin
// can hide, show and reorder. The ids are the ones the export endpoint reads. The choice is the
// admin's own and lives in this browser's storage.

import { cleanColumnIds } from '../columns.ts';

export const OPTIONAL_COLUMNS = [
  'amount',
  'reason',
  'actor',
  'store',
  'customer',
  'requested',
  'lossBearer',
  'ledger',
  'tax',
  'shipping',
  'settled',
  'stripeRefundId',
  'creditNote',
  'refundId',
  'sellerOrderId',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = [
  'amount',
  'reason',
  'actor',
  'store',
  'customer',
  'requested',
  'lossBearer',
];

/** Columns whose cells are money, which end with their header. */
export const MONEY_COLUMNS: readonly OptionalColumn[] = ['amount', 'tax', 'shipping'];

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
