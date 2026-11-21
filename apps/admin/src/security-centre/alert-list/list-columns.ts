// The columns of the alert list. Alert, Severity, Key, Events, Opened, State and Response are always
// shown; these are the ones an admin can show, hide and reorder. The ids are the ones the export
// endpoint reads. The choice is the admin's own and lives in this browser's storage.

import { cleanColumnIds } from '../../sales/columns.ts';

export const FIXED_COLUMNS = [
  'alert',
  'severity',
  'key',
  'events',
  'opened',
  'state',
  'response',
] as const;

export const OPTIONAL_COLUMNS = [
  'alert-id',
  'first-event',
  'last-event',
  'acknowledged',
  'resolved',
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = [];

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);
