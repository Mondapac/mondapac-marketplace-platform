// The columns of the Earnings payout list. "Payout on" and the status are always shown; these are
// the ones a seller can hide, show and reorder. The choice is the account's own and lives in this
// browser's storage, as the other seller lists do.

export const OPTIONAL_COLUMNS = [
  'note',
  'amount',
  'gross',
  'netted',
  'created',
  'updated',
  'payoutId',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

/** What the card showed: the details and the amount. "Created on" and "Updated on" start off. */
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['note', 'amount'];

/**
 * The columns a stored choice names, in its order: unknown and repeated ids are dropped. Nothing
 * stored means the defaults; a stored choice with no column left means the fixed columns alone.
 */
export function cleanColumns(saved: readonly unknown[] | undefined): readonly OptionalColumn[] {
  if (saved === undefined) return DEFAULT_COLUMNS;
  const known = saved.filter((id): id is OptionalColumn =>
    OPTIONAL_COLUMNS.some((column) => column === id),
  );
  return [...new Set(known)];
}

/** The export columns the shown list columns stand for, in the shown order. */
export const EXPORT_COLUMNS = ['gross', 'netted', 'created', 'updated'] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

export const exportColumnsOf = (columns: readonly OptionalColumn[]): readonly ExportColumn[] =>
  columns.filter((column): column is ExportColumn =>
    EXPORT_COLUMNS.some((exported) => exported === column),
  );
