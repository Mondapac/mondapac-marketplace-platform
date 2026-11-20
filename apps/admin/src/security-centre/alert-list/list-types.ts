// The security centre's alert list as a super list (list 37): the answer of GET
// security/admin/alerts/list (apps/api alert-list-flow.ts, `AlertListPage`) and the list's own
// state. One row per alert. A key that is an address is masked by the API, in rows and in files.

import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { isDatePreset, type DatePreset } from '../../sales/date-presets.ts';
import { SEVERITIES, type AlertSummary, type KeyType, type Severity } from '../types.ts';

export const PAGE_SIZE = 25;
/** Rows that can be ticked one by one for an export (the API takes up to 200 ids). */
export const SELECTION_MAX = 200;
/** The API's longest key value (an account id, an address, the Market code or an event id). */
export const SEARCH_MAX = 64;

/** The views: every alert, the live ones by state, the critical ones (live S1) and the resolved. */
export const VIEWS = ['all', 'open', 'acknowledged', 'critical', 'resolved'] as const;
export type View = (typeof VIEWS)[number];
export const isView = (value: unknown): value is View => VIEWS.some((view) => view === value);

export const SORTS = ['severity', 'opened', 'events', 'last-event'] as const;
export type Sort = (typeof SORTS)[number];
export type Direction = 'asc' | 'desc';
/** S1 first; newest, busiest and most recently active first. */
export const defaultDirection = (sort: Sort): Direction => (sort === 'severity' ? 'asc' : 'desc');

/** The row actions the API names, in the order the menu shows them; one it does not know is ignored. */
export const ROW_ACTIONS = ['open', 'acknowledge', 'resolve'] as const;
export type RowAction = (typeof ROW_ACTIONS)[number];

export interface AlertListRow extends AlertSummary {
  readonly actions: readonly string[];
}

export type AlertCounts = Readonly<Record<View, number>>;

export interface AlertListPage {
  readonly items: readonly AlertListRow[];
  /** Null with Previous and next. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  readonly counts: AlertCounts;
}

/**
 * The rules of the catalogue (apps/api security rules.ts), the codes a filter and a saved filter
 * may name; each has its name in the messages (`security-centre.list.rule.<code>`).
 */
export const RULE_CODES = [
  'admin-sign-in-after-failures',
  'payout-account-changes-burst',
  'sign-in-failures-account',
  'sign-in-failures-ip',
  'admin-second-factor-failures',
  'second-factor-locked',
  'admin-role-changes-burst',
  'money-movement-alert',
  'retired-category-relaxing-policy',
  'admin-bulk-pii-reveal',
  'webhook-signature-failures',
  'sign-in-throttled-burst',
  'payout-live-check-failures',
  'sign-in-failures-daily',
] as const;

export const KEY_TYPES: readonly KeyType[] = ['account', 'ip', 'market', 'event'];
/** The least events a filter can ask for. */
export const MIN_EVENTS_CHOICES = ['2', '5', '10', '25', '50', '100'] as const;

export const FILTER_FIELDS = ['severity', 'rule', 'keyType', 'opened', 'minEvents'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

/** The conditions of the filter panel; each is one value. */
export interface Filters {
  readonly severity?: Severity;
  readonly rule?: string;
  readonly keyType?: KeyType;
  readonly opened?: DatePreset;
  readonly minEvents?: string;
}

export const filterCount = (filters: Filters): number => Object.keys(filters).length;

/** The filters a panel answer (or a saved filter) holds: only a known value of a known field. */
export function filtersOf(values: Readonly<Record<string, string>>): Filters {
  const next: { -readonly [K in keyof Filters]: Filters[K] } = {};
  const severity = SEVERITIES.find((value) => value === values['severity']);
  if (severity !== undefined) next.severity = severity;
  const rule = RULE_CODES.find((value) => value === values['rule']);
  if (rule !== undefined) next.rule = rule;
  const keyType = KEY_TYPES.find((value) => value === values['keyType']);
  if (keyType !== undefined) next.keyType = keyType;
  const opened = values['opened'];
  if (isDatePreset(opened)) next.opened = opened;
  const events = MIN_EVENTS_CHOICES.find((value) => value === values['minEvents']);
  if (events !== undefined) next.minEvents = events;
  return next;
}

export interface Query {
  readonly view: View;
  /** The key of the alerts, exact (an account id, an address, the Market code or an event id). */
  readonly q: string;
  readonly filters: Filters;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly page: number;
}

export const DEFAULT_QUERY: Query = {
  view: 'open',
  q: '',
  filters: {},
  sort: 'severity',
  direction: 'asc',
  page: 1,
};
