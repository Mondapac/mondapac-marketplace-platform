// The columns of the Invoices list. Order is always shown; these are the ones an admin can hide,
// show and reorder. The ids are the export backend's column ids: do not rename them. The choice is
// the admin's own and lives in this browser's storage.

import { cleanColumnIds } from '../columns.ts';
import type { Tab } from './invoices-types.ts';

export const OPTIONAL_COLUMNS = [
  'issued',
  'store',
  'customer',
  'total',
  'tax',
  'reason',
  'shipping',
  'sellerOrderId',
  'documentId',
  'refundId',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = [
  'issued',
  'store',
  'customer',
  'total',
  'tax',
  'reason',
];

/** Columns whose cells are money, which end with their header. */
export const MONEY_COLUMNS: readonly OptionalColumn[] = ['total', 'tax', 'shipping'];

/** Columns that exist for credit notes only: skipped on the confirmations tab. */
export const CREDIT_NOTE_COLUMNS: readonly OptionalColumn[] = ['reason', 'documentId', 'refundId'];

export const columnsOnTab = (
  columns: readonly OptionalColumn[],
  tab: Tab,
): readonly OptionalColumn[] =>
  tab === 'credit-note' ? columns : columns.filter((id) => !CREDIT_NOTE_COLUMNS.includes(id));

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
