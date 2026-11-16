// The columns of the Shipments list. Order and Stage are always shown; these are the ones an admin
// can hide, show and reorder. The choice is the admin's own and lives in this browser's storage.

import { cleanColumnIds } from '../columns.ts';

/**
 * The columns of the picker. These ids are saved in each admin's browser, so they are not renamed;
 * the export endpoint's ids differ for two of them (see `exportColumnIds`), and the relay's
 * `exportColumns` list in `server/bff.ts` holds the export-side ids. A new column here needs its
 * export id in both places, and a test in `shipments.spec.tsx` that lists all of them.
 */
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

/**
 * The ids the export endpoint reads, where the picker's id is another: the delivery fee is
 * `shipping` and the seller order ID is `sellerOrderId` there. The picker's ids stay as they are
 * (they are the ones saved in the admin's browser).
 */
const EXPORT_IDS: Readonly<Partial<Record<OptionalColumn, string>>> = {
  fee: 'shipping',
  'seller-order': 'sellerOrderId',
};

export const exportColumnIds = (columns: readonly OptionalColumn[]): readonly string[] =>
  columns.map((id) => EXPORT_IDS[id] ?? id);
