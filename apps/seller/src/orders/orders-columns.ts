// The columns of the seller order list. The order reference is always shown (it links to the
// order); these are the ones a seller can hide, show and reorder. The choice is the account's own
// and lives in this browser's storage, as the product list's does.

export const OPTIONAL_COLUMNS = ['status', 'paid', 'items', 'total'] as const;
export type OrderColumn = (typeof OPTIONAL_COLUMNS)[number];

/** Every optional column, as the list showed before the choice existed. */
export const DEFAULT_COLUMNS: readonly OrderColumn[] = OPTIONAL_COLUMNS;

const isColumn = (id: unknown): id is OrderColumn =>
  OPTIONAL_COLUMNS.some((column) => column === id);

/**
 * The columns a stored choice names, in its order: unknown and repeated ids are dropped. Nothing
 * stored means the defaults; a stored choice with no column left means the order reference alone.
 */
export function cleanColumns(saved: readonly unknown[] | undefined): readonly OrderColumn[] {
  if (saved === undefined) return DEFAULT_COLUMNS;
  return [...new Set(saved.filter(isColumn))];
}
