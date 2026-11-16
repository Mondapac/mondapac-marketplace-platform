// The columns of the Shipments list. Order and Stage are always shown; these are the ones an admin
// can hide, show and reorder. The choice is the admin's own and lives in this browser's storage.

import { cleanColumnIds } from '../columns.ts';

export const OPTIONAL_COLUMNS = [
  'store',
  'customer',
  'paid',
  'delivery',
  'carrier',
  'total',
  'ready',
  'shipped',
  'delivered',
  'fleet',
  'fee',
  'refunded',
  'seller-order',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = [
  'store',
  'customer',
  'paid',
  'delivery',
  'carrier',
  'total',
];

/** Columns whose cells are money, which end with their header. */
export const MONEY_COLUMNS: readonly OptionalColumn[] = ['total', 'fee', 'refunded'];

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
