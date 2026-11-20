// The columns of the seller ledger list. Kind, Amount, Recorded on and Order are always shown;
// these are the ones an admin can show, hide and reorder. The choice is the admin's own and lives
// in this browser's storage. The export reads its own column ids (`LEDGER_EXPORT_COLUMNS` of the
// API); `exportColumns` maps the columns on screen to them.

import { cleanColumnIds } from '../../sales/columns.ts';

export const OPTIONAL_COLUMNS = [
  'occurred',
  'seller-order',
  'order-line',
  'rate',
  'base',
  'source',
  'entry',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

/** The four main columns already fit the card, so nothing else shows until it is chosen. */
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = [];

/** The columns always shown, in their order (the kind is the card's title on a phone). */
export const FIXED_COLUMNS = ['kind', 'amount', 'recorded', 'order'] as const;

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);

/** The optional columns of the API's export; the file always has the seller order. */
type ExportColumn = 'occurred' | 'order-line' | 'rate' | 'base' | 'source' | 'entry-id';

const EXPORT_OF: Readonly<Record<OptionalColumn, ExportColumn | null>> = {
  occurred: 'occurred',
  'seller-order': null,
  'order-line': 'order-line',
  rate: 'rate',
  base: 'base',
  source: 'source',
  entry: 'entry-id',
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
