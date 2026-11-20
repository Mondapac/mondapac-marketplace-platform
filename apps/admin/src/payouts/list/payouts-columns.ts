// The columns of the Payouts list. Payout, State, Store, Transfer and Created are always shown;
// these are the ones an admin can show, hide and reorder. The ids are the ones the export reads,
// so the file holds the columns on screen. The choice is the admin's own and lives in this
// browser's storage.

import { cleanColumnIds } from '../../sales/columns.ts';

export const OPTIONAL_COLUMNS = [
  'gross',
  'netted',
  'approval-mode',
  'approval-reason',
  'slot',
  'state-changed',
  'outcome',
  'seller-id',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['approval-reason', 'slot'];

/** The columns always shown, in their order (the payout is the card's title). */
export const FIXED_COLUMNS = ['payout', 'state', 'store', 'transfer', 'created'] as const;

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
