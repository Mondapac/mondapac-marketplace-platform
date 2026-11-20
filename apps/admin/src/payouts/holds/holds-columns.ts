// The columns of the seller payout holds list. Covers, Reason, Placed on and Status are always
// shown; these are the ones an admin can show, hide and reorder. The choice is the admin's own and
// lives in this browser's storage. The export reads its own column ids (`HOLD_EXPORT_COLUMNS` of
// the API); `exportColumns` maps the columns on screen to them.

import { cleanColumnIds } from '../../sales/columns.ts';

export const OPTIONAL_COLUMNS = ['origin', 'released', 'release-reason', 'hold'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['origin', 'released'];

/** The columns always shown, in their order (the cover is the card's title on a phone). */
export const FIXED_COLUMNS = ['covers', 'reason', 'placed', 'status'] as const;

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);

/** The optional columns of the API's export; the file always has who placed it and when released. */
type ExportColumn = 'release-reason' | 'hold-id';

const EXPORT_OF: Readonly<Record<OptionalColumn, ExportColumn | null>> = {
  origin: null,
  released: null,
  'release-reason': 'release-reason',
  hold: 'hold-id',
};

/** The export columns for the columns on screen, in the shown order. */
export function exportColumns(columns: readonly OptionalColumn[]): readonly ExportColumn[] {
  const out: ExportColumn[] = [];
  for (const column of columns) {
    const mapped = EXPORT_OF[column];
    if (mapped !== null) out.push(mapped);
  }
  return [...new Set(out)];
}
