import type { Temporal } from '@mondapac/shared-kernel';
import type { AlertState } from './alert';
import type { AlertKeyType } from './rules';
import { SEVERITIES, type SecuritySeverity } from './severity';

// The security centre's alert list as a super list (phase 3, list 37; CLAUDE.md rule 14): the
// Market's alerts with views, filters, sort, page numbers or Previous/Next, the view counts, the
// row Actions menu and the export. It only reads. Acknowledging and resolving run through their
// own use cases (version check, audit, the s1 resolver rule), so the list offers no bulk action.

/** The views (tabs): every alert, the live ones by state, the critical ones, and the resolved. */
export const ALERT_LIST_VIEWS = ['all', 'open', 'acknowledged', 'critical', 'resolved'] as const;
export type AlertListView = (typeof ALERT_LIST_VIEWS)[number];

export const ALERT_SORT_KEYS = ['severity', 'opened', 'events', 'last-event'] as const;
export type AlertSortKey = (typeof ALERT_SORT_KEYS)[number];

export interface AlertSort {
  readonly key: AlertSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Every field is an AND; null leaves it out. */
export interface AlertListFilter {
  readonly view: AlertListView;
  /** One or more severities; empty leaves it out. */
  readonly severities: readonly SecuritySeverity[];
  /** A rule code of the catalogue. */
  readonly rule: string | null;
  readonly keyType: AlertKeyType | null;
  /** The key in full, exact (an account id, an address as canonical text, the Market, an event). */
  readonly keyValue: string | null;
  /** Opened at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  readonly minEvents: number | null;
}

export const EMPTY_ALERT_LIST_FILTER: AlertListFilter = Object.freeze({
  view: 'all',
  severities: [],
  rule: null,
  keyType: null,
  keyValue: null,
  from: null,
  to: null,
  minEvents: null,
});

/** The count of each view for the Market, whatever the filter. */
export type AlertViewCounts = Readonly<Record<AlertListView, number>>;

export const ALERT_ROW_ACTIONS = ['open', 'acknowledge', 'resolve'] as const;
export type AlertRowAction = (typeof ALERT_ROW_ACTIONS)[number];

/** The columns an export may add, in the order the panel's column picker lists them. */
export const ALERT_EXPORT_COLUMNS = [
  'alert-id',
  'rule',
  'first-event',
  'last-event',
  'acknowledged',
  'resolved',
  'resolution',
] as const;
export type AlertExportColumn = (typeof ALERT_EXPORT_COLUMNS)[number];

/** The minimum of what {@link alertMatches} reads of an alert. */
export interface AlertSubject {
  readonly id: string;
  readonly rule: string;
  readonly severity: SecuritySeverity;
  readonly state: AlertState;
  readonly keyType: AlertKeyType;
  readonly keyValue: string;
  readonly eventCount: number;
  readonly lastEventAt: Temporal.Instant;
  readonly openedAt: Temporal.Instant;
}

/** Whether an alert is in a view (`critical` is the live s1 alerts). */
export function inAlertView(view: AlertListView, alert: AlertSubject): boolean {
  switch (view) {
    case 'all':
      return true;
    case 'open':
    case 'acknowledged':
    case 'resolved':
      return alert.state === view;
    case 'critical':
      return alert.severity === 's1' && alert.state !== 'resolved';
  }
}

/** Whether an alert meets a filter; the in-memory twin of the repository's `where`. */
export function alertMatches(alert: AlertSubject, filter: AlertListFilter): boolean {
  if (!inAlertView(filter.view, alert)) return false;
  if (filter.severities.length > 0 && !filter.severities.includes(alert.severity)) return false;
  if (filter.rule !== null && alert.rule !== filter.rule) return false;
  if (filter.keyType !== null && alert.keyType !== filter.keyType) return false;
  if (filter.keyValue !== null && alert.keyValue !== filter.keyValue) return false;
  const at = alert.openedAt.epochMilliseconds;
  if (filter.from !== null && at < filter.from.epochMilliseconds) return false;
  if (filter.to !== null && at >= filter.to.epochMilliseconds) return false;
  if (filter.minEvents !== null && alert.eventCount < filter.minEvents) return false;
  return true;
}

const severityRank = (severity: SecuritySeverity): number => SEVERITIES.indexOf(severity);

/**
 * Sorts two alerts. `severity` puts s1 first when ascending and breaks ties by the newest opened,
 * the page's old order; every other key breaks ties by the id, so a page boundary never repeats a row.
 */
export function compareAlerts(a: AlertSubject, b: AlertSubject, sort: AlertSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const idOrder = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  switch (sort.key) {
    case 'severity': {
      const bySeverity = severityRank(a.severity) - severityRank(b.severity);
      if (bySeverity !== 0) return sign * bySeverity;
      const byOpened = b.openedAt.epochMilliseconds - a.openedAt.epochMilliseconds;
      return byOpened !== 0 ? byOpened : -idOrder;
    }
    case 'opened': {
      const diff = a.openedAt.epochMilliseconds - b.openedAt.epochMilliseconds;
      return diff !== 0 ? sign * diff : sign * idOrder;
    }
    case 'last-event': {
      const diff = a.lastEventAt.epochMilliseconds - b.lastEventAt.epochMilliseconds;
      return diff !== 0 ? sign * diff : sign * idOrder;
    }
    case 'events': {
      const diff = a.eventCount - b.eventCount;
      return diff !== 0 ? sign * diff : sign * idOrder;
    }
  }
}
