// The columns of the queue list. Seller, Type, Kind, Issuer and Waiting since are always shown;
// these are the ones an admin can show, hide and reorder. The ids are the ones the export endpoint
// reads. The choice is the admin's own and lives in this browser's storage.

import { cleanColumnIds } from '../../sales/columns.ts';

export const OPTIONAL_COLUMNS = [
  'submission-no',
  'certificate-id',
  'submission-id',
  'seller-id',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['submission-no'];

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
