// The columns of the Seller accounts list. Seller, Status, Ready and Details due are always
// shown; these can be shown, hidden and moved. The ids are the ones the export reads. The choice
// is the admin's own and lives in this browser's storage.

import { cleanColumnIds } from '../../sales/columns.ts';

export const OPTIONAL_COLUMNS = ['cooling-off', 'paused', 'last-read', 'seller-id'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['cooling-off', 'paused', 'last-read'];

export const FIXED_COLUMNS = ['seller', 'status', 'ready', 'requirements'] as const;

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
