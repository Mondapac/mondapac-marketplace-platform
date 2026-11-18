// The columns of the seller order list. The order reference and the status are always shown (the
// reference links to the order); these are the ones a seller can hide, show and reorder. The choice
// is the account's own and lives in this browser's storage, as the product list's does.

export const OPTIONAL_COLUMNS = ['paid', 'delivery', 'items', 'total'] as const;
export type OrderColumn = (typeof OPTIONAL_COLUMNS)[number];

/** The columns the list showed before the delivery column existed. */
export const DEFAULT_COLUMNS: readonly OrderColumn[] = ['paid', 'items', 'total'];

/**
 * The columns a stored choice names, in its order: unknown and repeated ids are dropped. Nothing
 * stored means the defaults; a stored choice with no column left means the fixed columns alone.
 */
export function cleanColumns(saved: readonly unknown[] | undefined): readonly OrderColumn[] {
  if (saved === undefined) return DEFAULT_COLUMNS;
  const known = saved.filter((id): id is OrderColumn =>
    OPTIONAL_COLUMNS.some((column) => column === id),
  );
  return [...new Set(known)];
}
