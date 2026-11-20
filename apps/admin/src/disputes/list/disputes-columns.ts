// The columns of the Disputes list. Case, Stage, Sellers, Amount and Opened are always shown;
// these are the ones an admin can show, hide and reorder. The ids are the ones the export reads,
// so the file holds the columns on screen. The choice is the admin's own and lives in this
// browser's storage.

import { cleanColumnIds } from '../../sales/columns.ts';

export const OPTIONAL_COLUMNS = [
  'money',
  'reason',
  'evidence-due',
  'stripe-status',
  'updated',
  'seller-ids',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

// The deadline first: it is what an admin acts on. Money stays one click away (fits 1280 px).
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['evidence-due', 'reason'];

/** The columns always shown, in their order (the case is the card's title). */
export const FIXED_COLUMNS = ['case', 'stage', 'sellers', 'amount', 'opened'] as const;

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
