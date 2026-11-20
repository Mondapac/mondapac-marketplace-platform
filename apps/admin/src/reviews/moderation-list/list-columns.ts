// The columns of the moderation list. Review, Rating, Status, Open reports and Submitted (as in the export) are always
// shown; these are the ones an admin can show, hide and reorder. The ids are the ones the export
// endpoint reads. The choice is the admin's own and lives in this browser's storage.

import { cleanColumnIds } from '../../sales/columns.ts';

export const FIXED_COLUMNS = ['review', 'rating', 'status', 'reports', 'submitted'] as const;

export const OPTIONAL_COLUMNS = [
  'review-id',
  'product-id',
  'offer-id',
  'seller-id',
  'locale',
  'edited',
  'signals',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['signals', 'seller-id'];

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
