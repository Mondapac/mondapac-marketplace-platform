// The columns of the Credit requests list. Customer, Amount, Status and Requested are always
// shown; these are the ones an admin can show, hide and reorder. The choice is the admin's own and
// lives in this browser's storage. The export reads its own column ids (`CREDIT_EXPORT_COLUMNS` of
// the API); `exportColumns` maps the columns on screen to them.

import { cleanColumnIds } from '../../sales/columns.ts';

export const OPTIONAL_COLUMNS = [
  'reason',
  'requested-by',
  'until',
  'approval-reason',
  'decided-by',
  'decision-reason',
  'note',
  'journal',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['reason', 'requested-by', 'until'];

/** The columns always shown, in their order (the customer is the card's title). */
export const FIXED_COLUMNS = ['customer', 'amount', 'status', 'requested'] as const;

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);

/** The optional columns of the API's export (`CREDIT_EXPORT_COLUMNS`); the file always has the rest. */
type ExportColumn =
  'note' | 'approval-reason' | 'expires' | 'decided-by' | 'decided' | 'decision-reason' | 'journal';

/**
 * The export columns for the columns on screen, in the shown order. Reason and Requested by are
 * always in the file; the one Expires or decided column is two columns there.
 */
export function exportColumns(columns: readonly OptionalColumn[]): readonly ExportColumn[] {
  const out: ExportColumn[] = [];
  for (const column of columns) {
    if (column === 'until') out.push('expires', 'decided');
    else if (column !== 'reason' && column !== 'requested-by') out.push(column);
  }
  return [...new Set(out)];
}
