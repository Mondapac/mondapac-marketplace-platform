import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
  type ExportCell,
  type ExportFile,
  type SheetWriter,
} from '../../../platform/list-export';
import {
  heldKeys,
  listPage,
  listQueryInvalid,
  pageWindow,
  parseInstantRange,
  parseListQuery,
  rowActions,
  MAX_PAGED_ROWS,
  type ListPage,
  type ListPagingMode,
  type ListQueryFailure,
  type PermissionProbe,
  type RowActionRule,
} from '../../../platform/list-query';
import { SECURITY_RESPOND } from '../contracts/permissions';
import type { SecurityAlert } from '../domain/alert';
import {
  ALERT_EXPORT_COLUMNS,
  ALERT_LIST_VIEWS,
  ALERT_SORT_KEYS,
  EMPTY_ALERT_LIST_FILTER,
  type AlertExportColumn,
  type AlertListFilter,
  type AlertListView,
  type AlertRowAction,
  type AlertSort,
  type AlertViewCounts,
} from '../domain/alert-list';
import { ALERT_KEY_TYPES, SECURITY_RULES, type AlertKeyType } from '../domain/rules';
import { isSeverity, type SecuritySeverity } from '../domain/severity';
import type { SecurityDependencies } from './security-dependencies';
import {
  adminAccountId,
  namesFor,
  s1ResolversOf,
  summaryOf,
  type AlertSummaryView,
} from './respond-flow';

// The security centre's alert list as a super list (phase 3, list 37) and its export. A read:
// nothing here acknowledges or resolves. The row actions only name what the caller may do; each
// act checks its own key, the version, the s1 resolver rule and the audit when it runs, so the
// list offers no bulk action. An address key is masked in rows and in the file, and a resolution
// note is never exported.

export const ALERT_ROW_KEYS = [SECURITY_RESPOND.key] as const;

export interface AlertListDependencies extends Pick<
  SecurityDependencies,
  'unitOfWork' | 'alerts' | 'roster' | 'names'
> {
  /** One probe per key of {@link ALERT_ROW_KEYS}. */
  readonly probes: Readonly<Record<(typeof ALERT_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const ALERT_LIST_DEFAULT_PAGE_SIZE = 25;
export const ALERT_LIST_MAX_PAGE_SIZE = 100;
export const ALERT_EXPORT_MAX_IDS = 200;

const SELECTOR_KEYS = [
  'view',
  'severity',
  'rule',
  'keyType',
  'keyValue',
  'minEvents',
  'from',
  'to',
] as const;
const LIST_KEYS = new Set<string>([
  ...SELECTOR_KEYS,
  'sort',
  'direction',
  'page',
  'pageSize',
  'paging',
]);
const EXPORT_KEYS = new Set<string>([
  ...SELECTOR_KEYS,
  'sort',
  'direction',
  'format',
  'columns',
  'ids',
]);

export type AlertListInput = Readonly<Record<string, unknown>>;

export type AlertListFailure =
  | ListQueryFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'security.alert-not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface AlertListRow extends AlertSummaryView {
  readonly actions: readonly AlertRowAction[];
}

export interface AlertListPage extends ListPage<AlertListRow> {
  /** The count of each view for the Market, whatever the filter. */
  readonly counts: AlertViewCounts;
}

// The column holds 64 characters, so a longer value could never match.
const KEY_VALUE_MAX = 64;
const MIN_EVENTS = /^[1-9]\d{0,8}$/;

const hasControl = (text: string): boolean =>
  Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

function parseSelector(record: AlertListInput): Result<AlertListFilter, ListQueryFailure> {
  let view: AlertListView = 'all';
  if (!absent(record['view'])) {
    const found = ALERT_LIST_VIEWS.find((candidate) => candidate === record['view']);
    if (found === undefined) return listQueryInvalid('view', 'value');
    view = found;
  }
  const severities: SecuritySeverity[] = [];
  if (!absent(record['severity'])) {
    if (typeof record['severity'] !== 'string') return listQueryInvalid('severity', 'format');
    for (const part of record['severity'].split(',')) {
      if (!isSeverity(part)) return listQueryInvalid('severity', 'value');
      if (!severities.includes(part)) severities.push(part);
    }
  }
  let rule: string | null = null;
  if (!absent(record['rule'])) {
    const code = record['rule'];
    if (typeof code !== 'string' || !SECURITY_RULES.some((candidate) => candidate.code === code)) {
      return listQueryInvalid('rule', 'value');
    }
    rule = code;
  }
  let keyType: AlertKeyType | null = null;
  if (!absent(record['keyType'])) {
    const found = ALERT_KEY_TYPES.find((candidate) => candidate === record['keyType']);
    if (found === undefined) return listQueryInvalid('keyType', 'value');
    keyType = found;
  }
  let keyValue: string | null = null;
  if (!absent(record['keyValue'])) {
    const raw = typeof record['keyValue'] === 'string' ? record['keyValue'].trim() : '';
    if (raw === '' || Array.from(raw).length > KEY_VALUE_MAX || hasControl(raw)) {
      return listQueryInvalid('keyValue', 'format');
    }
    keyValue = raw;
  }
  let minEvents: number | null = null;
  if (!absent(record['minEvents'])) {
    if (typeof record['minEvents'] !== 'string' || !MIN_EVENTS.test(record['minEvents'])) {
      return listQueryInvalid('minEvents', 'format');
    }
    minEvents = Number(record['minEvents']);
  }
  const range = parseInstantRange(record, '');
  if (!range.ok) return range;
  return ok({
    ...EMPTY_ALERT_LIST_FILTER,
    view,
    severities,
    rule,
    keyType,
    keyValue,
    minEvents,
    from: range.value.from,
    to: range.value.to,
  });
}

function unknownKey(record: AlertListInput, allowed: ReadonlySet<string>): string | null {
  return Object.keys(record).find((key) => !allowed.has(key)) ?? null;
}

const SPEC = {
  sorts: ALERT_SORT_KEYS,
  // The page's old order: s1 first, then the newest opened.
  defaultSort: 'severity',
  defaultDirection: () => 'asc' as const,
  defaultPageSize: ALERT_LIST_DEFAULT_PAGE_SIZE,
  maxPageSize: ALERT_LIST_MAX_PAGE_SIZE,
  maxPage: MAX_PAGED_ROWS,
} as const;

interface RowSubject {
  readonly state: SecurityAlert['state'];
  readonly severity: SecuritySeverity;
  readonly resolvesCritical: boolean;
}

/** The row Actions menu: Open always; Acknowledge while open; Resolve until resolved (s1 by roster). */
const ROW_RULES: readonly RowActionRule<RowSubject>[] = [
  { id: 'open', permission: null },
  { id: 'acknowledge', permission: SECURITY_RESPOND.key, when: (row) => row.state === 'open' },
  {
    id: 'resolve',
    permission: SECURITY_RESPOND.key,
    when: (row) => row.state !== 'resolved' && (row.severity !== 's1' || row.resolvesCritical),
  },
];

/** The alerts of the list: one page with its total or without, the view counts and row actions. */
export async function listAlertRows(
  deps: AlertListDependencies,
  context: CallContext,
  input: AlertListInput,
): Promise<Result<AlertListPage, AlertListFailure>> {
  const viewer = adminAccountId(context);
  if (viewer === null) return err({ code: 'access.denied' });
  const record = input ?? {};
  const stray = unknownKey(record, LIST_KEYS);
  if (stray !== null) return listQueryInvalid(stray, 'unknown');
  const query = parseListQuery(record, SPEC);
  if (!query.ok) return query;
  if ((query.value.page - 1) * query.value.pageSize >= MAX_PAGED_ROWS) {
    return listQueryInvalid('page', 'range');
  }
  const selector = parseSelector(record);
  if (!selector.ok) return selector;
  const filter = selector.value;
  const sort: AlertSort = { key: query.value.sort, direction: query.value.direction };
  const { offset, limit } = pageWindow(query.value);
  const paging: ListPagingMode = query.value.paging;

  const read = await deps.unitOfWork.run<
    {
      readonly rows: readonly SecurityAlert[];
      readonly counts: AlertViewCounts;
      readonly total: number | null;
    },
    never
  >(
    context.market,
    async () => {
      const rows = await deps.alerts.queryList(context.market, filter, sort, offset, limit);
      const counts = await deps.alerts.viewCounts(context.market);
      const total =
        paging === 'pages' ? await deps.alerts.countListWhere(context.market, filter) : null;
      return ok({ rows, counts, total });
    },
    { readOnly: true },
  );
  if (!read.ok) throw new Error('security.query-security-alerts: the read failed');

  const listed = listPage(read.value.rows, query.value, read.value.total);
  // Page numbers stop at 10,000 rows, so Previous/Next must not offer a page that is refused.
  const page =
    offset + query.value.pageSize >= MAX_PAGED_ROWS ? { ...listed, hasNext: false } : listed;
  const granted =
    page.items.length === 0 ? new Set<string>() : await heldKeys(context, deps.probes);
  const resolvesCritical = s1ResolversOf(deps.roster.roster()).includes(viewer);
  const names = await namesFor(deps, context, page.items);
  return ok({
    ...page,
    items: page.items.map((alert) => ({
      ...summaryOf(alert, names),
      actions: rowActions(
        { state: alert.state, severity: alert.severity, resolvesCritical },
        ROW_RULES,
        granted,
      ) as AlertRowAction[],
    })),
    counts: read.value.counts,
  });
}

// --- the export --------------------------------------------------------------------------------

export interface AlertExportInput {
  readonly [key: string]: unknown;
}

const HEADERS: Readonly<Record<AlertExportColumn | 'base', readonly string[]>> = {
  base: ['Alert', 'Severity', 'State', 'Key type', 'Key', 'Events', 'Opened (UTC)'],
  'alert-id': ['Alert ID'],
  rule: ['Rule'],
  'first-event': ['First event (UTC)'],
  'last-event': ['Last event (UTC)'],
  acknowledged: ['Acknowledged (UTC)', 'Acknowledged by'],
  resolved: ['Resolved (UTC)'],
  resolution: ['Resolution'],
};

const text = (instant: Temporal.Instant | null): string => instant?.toString() ?? '';

function cellsOf(
  column: AlertExportColumn,
  alert: SecurityAlert,
  view: AlertSummaryView,
): ExportCell[] {
  switch (column) {
    case 'alert-id':
      return [alert.id];
    case 'rule':
      return [alert.rule];
    case 'first-event':
      return [text(alert.firstEventAt)];
    case 'last-event':
      return [text(alert.lastEventAt)];
    case 'acknowledged':
      return [text(alert.acknowledgedAt), view.acknowledgedByName ?? ''];
    case 'resolved':
      return [text(alert.resolvedAt)];
    case 'resolution':
      return [alert.resolution ?? ''];
  }
}

/**
 * The alert list as a CSV or XLSX file: the chosen `ids` (at most 200; an id outside the Market
 * refuses the whole request as not found) or what the selector keys match, at most 10,000 (more is
 * `batch.too-large` with the total), in the list's sort. With `ids` the selector keys are ignored
 * and the rows keep the order of the ids. An address is masked; a resolution note is never written.
 */
export async function exportAlertRows(
  deps: AlertListDependencies,
  context: CallContext,
  input: AlertExportInput,
): Promise<Result<ExportFile, AlertListFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const record = input ?? {};
  const stray = unknownKey(record, EXPORT_KEYS);
  if (stray !== null) return listQueryInvalid(stray, 'unknown');
  const format = parseExportFormat(record['format']);
  if (!format.ok) return format;
  const columns = parseExportColumns(record['columns'], ALERT_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;

  let rows: readonly SecurityAlert[];
  if (record['ids'] !== undefined) {
    if (typeof record['ids'] !== 'string') return listQueryInvalid('ids', 'type');
    const listed = parseExportIds(record['ids'], ALERT_EXPORT_MAX_IDS, (part) => {
      const id = part.trim().toLowerCase();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly SecurityAlert[], never>(
      market,
      async () => ok(await deps.alerts.findByIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) throw new Error('security.export-security-alerts: the read failed');
    const known = new Map<string, SecurityAlert>(found.value.map((row) => [row.id, row]));
    if (wanted.some((alertId) => !known.has(alertId))) {
      return err({ code: 'security.alert-not-found' });
    }
    rows = wanted.map((alertId) => known.get(alertId) as SecurityAlert);
  } else {
    const query = parseListQuery(record, SPEC);
    if (!query.ok) return query;
    const selector = parseSelector(record);
    if (!selector.ok) return selector;
    const filter = selector.value;
    const sort: AlertSort = { key: query.value.sort, direction: query.value.direction };
    const picked = await deps.unitOfWork.run<
      { readonly rows: readonly SecurityAlert[]; readonly total: number },
      never
    >(
      market,
      async () => {
        const found = await deps.alerts.queryList(
          market,
          filter,
          sort,
          0,
          LIST_EXPORT_MAX_ROWS + 1,
        );
        const total =
          found.length <= LIST_EXPORT_MAX_ROWS
            ? found.length
            : await deps.alerts.countListWhere(market, filter);
        return ok({ rows: found, total });
      },
      { readOnly: true },
    );
    if (!picked.ok) throw new Error('security.export-security-alerts: the read failed');
    const size = checkExportSize(picked.value.rows.length, picked.value.total);
    if (!size.ok) return size;
    rows = picked.value.rows;
  }

  const names = await namesFor(deps, context, rows);
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'security-alerts',
      sheetName: 'Security alerts',
      day: deps.clock.now().toString().slice(0, 10),
      groups: exportRows(
        rows.map((alert) => ({ alert, view: summaryOf(alert, names) })),
        columns.value,
      ),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

/** The header and then every line as one group, read as an async sequence (nothing is awaited). */
function exportRows(
  items: readonly { readonly alert: SecurityAlert; readonly view: AlertSummaryView }[],
  columns: readonly AlertExportColumn[],
): AsyncIterable<readonly (readonly ExportCell[])[]> {
  const groups: (readonly (readonly ExportCell[])[])[] = [
    [[...HEADERS.base, ...columns.flatMap((column) => HEADERS[column])]],
    items.map(({ alert, view }) => [
      view.title,
      view.severity,
      view.state,
      view.keyType,
      view.keyLabel,
      view.eventCount,
      view.openedAt.toString(),
      ...columns.flatMap((column) => cellsOf(column, alert, view)),
    ]),
  ];
  return {
    [Symbol.asyncIterator]() {
      let next = 0;
      return {
        next: () =>
          Promise.resolve(
            next < groups.length
              ? { done: false as const, value: groups[next++]! }
              : { done: true as const, value: undefined },
          ),
      };
    },
  };
}
