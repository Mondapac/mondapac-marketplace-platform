// The columns of the admin order list. The order reference and the status are always shown; these
// are the ones an admin can hide, show and reorder. The choice is the admin's own and lives in this
// browser's storage, as the product list's does.

import { cleanColumnIds } from '../sales/columns.ts';

export const OPTIONAL_COLUMNS = [
  'placed',
  'paid',
  'payment',
  'customer',
  'sellers',
  'total',
] as const;
export type OrderColumn = (typeof OPTIONAL_COLUMNS)[number];

/**
 * The columns shown until the admin chooses others. Four fit beside the sidebar at 1280 px with
 * the money column in view; Paid is one click away in the column picker. Total comes before the
 * sellers, so a narrow screen never cuts the money off.
 */
export const DEFAULT_COLUMNS: readonly OrderColumn[] = ['placed', 'customer', 'total', 'sellers'];

/**
 * The columns a stored choice names, in its order: unknown and repeated ids are dropped. Nothing
 * stored means the defaults; a stored choice with no column left means the fixed columns alone.
 */
export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OrderColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
