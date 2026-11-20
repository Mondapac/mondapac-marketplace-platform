// The columns of the Account deletion requests list. Account, Status, Requested and Deletes on are
// always shown; these are the ones an admin can show, hide and reorder. The choice is the admin's
// own and lives in this browser's storage. The export reads its own column ids
// (`DELETION_EXPORT_COLUMNS` of the API); `exportColumns` maps the columns on screen to them.

import { cleanColumnIds } from '../../sales/columns.ts';

export const OPTIONAL_COLUMNS = [
  'requested-by',
  'cancelled',
  'cancel-reason',
  'completed',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['requested-by'];

/** The columns always shown, in their order (the account is the card's title). */
export const FIXED_COLUMNS = ['account', 'status', 'requested', 'deletes-on'] as const;

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);

/** The optional columns of the API's export; the file always has "requested by" and the dates. */
type ExportColumn = 'cancelled' | 'cancel-reason' | 'completed';

/** The export columns for the columns on screen, in the shown order. */
export function exportColumns(columns: readonly OptionalColumn[]): readonly ExportColumn[] {
  const out: ExportColumn[] = [];
  for (const column of columns) if (column !== 'requested-by') out.push(column);
  return [...new Set(out)];
}
