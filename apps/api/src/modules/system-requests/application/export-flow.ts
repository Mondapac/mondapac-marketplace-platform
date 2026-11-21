import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
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
import type { ReviewArea, Risk } from '../domain/areas';
import {
  displayNumber,
  type Decision,
  type RequestStatus,
  type SystemRequest,
  type Viewer,
} from '../domain/request';
import { MATCHING_FIELDS, parseQuery, resolveNow, viewFilter } from './list-flow';
import type { MarketZone } from './ports/market-zone';
import type { Direction, Keyset, RequestFilter, RequestSort } from './ports/request.repository';
import {
  MAX_BULK,
  requestIdOf,
  requestView,
  reviewableAreas,
  signedInAdmin,
  withLabels,
  type RequestView,
  type SystemRequestsFailure,
} from './request-flow';
import type { SystemRequestsDependencies } from './system-requests-dependencies';

// The export of the System requests queue (CLAUDE.md rule 14): the chosen rows (`ids`) or every
// row the list's view, search and filters match, as CSV or XLSX, with the fixed columns and the
// optional ones the admin shows. It reads what the list reads, with the list's own parser and
// view filter, so the Market, the view (Needs my review is the caller's review areas, not their
// own) and every filter are the list's. The values before and after a change are never written:
// the list keeps them for the author and the area's reviewers only, and a file travels further.

/** Rows read per page while the file streams. */
export const EXPORT_PAGE = 100;

/**
 * The most a refused export counts when it says how many rows matched: the count stops here, so a
 * refusal never scans a whole large Market. A total at this cap reads "at least" in the panel.
 */
export const EXPORT_TOTAL_CAP = 100_000;

/** The optional columns, as the queue's column picker names them. */
export const EXPORT_COLUMNS = [
  'subject',
  'requestedBy',
  'applied',
  'due',
  'decidedBy',
  'decided',
  'comments',
] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/** The keys of the export itself, beside the list's filter keys and its sort. */
const OWN_KEYS = ['format', 'columns', 'ids', 'zone', 'sort', 'direction'] as const;
const EXPORT_KEYS = new Set<string>([...OWN_KEYS, ...MATCHING_FIELDS]);

/** A type literal, not the shared interface, so the route's refusal map can read it. */
export type ExportFailure =
  | SystemRequestsFailure
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface SystemRequestsExportDependencies extends SystemRequestsDependencies {
  readonly sheetWriter: SheetWriter;
  /** The Market's zone, for the times when the panel names none. */
  readonly zone: MarketZone;
}

const HEADERS: Readonly<Record<ExportColumn | 'base', readonly string[]>> = {
  base: ['Request', 'Note', 'Area', 'Risk', 'Status'],
  subject: ['Subject type', 'Subject', 'Subject ID'],
  requestedBy: ['Requested by', 'Requested by ID'],
  applied: ['Applied'],
  due: ['Review due', 'Overdue'],
  decidedBy: ['Decided by', 'Decided by ID'],
  decided: ['Decided', 'Decision'],
  comments: ['Comments'],
};

/** The panel's words (`system-requests.area`, `.risk`, `.status`, `.decision`). */
const AREA_LABELS: Readonly<Record<ReviewArea, string>> = Object.freeze({
  people: 'People',
  money: 'Money',
  delivery: 'Delivery',
  catalogue: 'Catalogue',
  certification: 'Certification',
  marketplace: 'Marketplace',
  content: 'Content',
  'review-policy': 'Approval rules',
});
const RISK_LABELS: Readonly<Record<Risk, string>> = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
});
const STATUS_LABELS: Readonly<Record<RequestStatus, string>> = Object.freeze({
  open: 'Open',
  approved: 'Approved',
  reverted: 'Reverted',
});
const DECISION_LABELS: Readonly<Record<Decision, string>> = Object.freeze({
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
});

const invalid = (path: string, code: string): { ok: false; error: SystemRequestsFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: SystemRequestsFailure;
  };

/** An instant in the file's zone, ISO 8601 with its offset ("2026-11-16T09:30:00+10:00"). */
function zonedText(instant: Temporal.Instant | null, zone: string): string {
  if (instant === null) return '';
  return instant
    .toZonedDateTimeISO(zone)
    .toString({ timeZoneName: 'never', smallestUnit: 'second' });
}

function parseZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  try {
    // Any instant names the zone; epoch keeps the wall clock out of it.
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value).timeZoneId;
  } catch {
    return null;
  }
}

function cellsOf(
  column: ExportColumn,
  row: RequestView,
  zone: string,
  now: Temporal.Instant,
): readonly ExportCell[] {
  switch (column) {
    case 'subject':
      return [row.subjectKind, row.subjectLabel ?? '', row.subjectRef];
    case 'requestedBy':
      return [row.requestedByName ?? '', row.requestedBy];
    case 'applied':
      return [zonedText(row.appliedAt, zone)];
    case 'due':
      return [
        zonedText(row.reviewDueAt, zone),
        row.status === 'open' && row.reviewDueAt.epochMilliseconds <= now.epochMilliseconds
          ? 'Yes'
          : 'No',
      ];
    case 'decidedBy':
      return [row.decidedByName ?? '', row.decidedBy ?? ''];
    case 'decided':
      return [
        zonedText(row.decidedAt, zone),
        row.decision === null ? '' : DECISION_LABELS[row.decision],
      ];
    case 'comments':
      return [row.commentCount];
  }
}

/** Where the next keyset page starts: after `last` in the sort. */
function keysetOf(sort: RequestSort, last: SystemRequest): Keyset {
  const value =
    sort === 'number' ? last.number : sort === 'due' ? last.reviewDueAt : last.appliedAt;
  return { value, number: last.number };
}

/** What the file holds: the chosen rows, read once, or the filter, read page by page. */
type Selection =
  | { readonly kind: 'ids'; readonly rows: readonly SystemRequest[] }
  | {
      readonly kind: 'filter';
      readonly filter: RequestFilter | null;
      readonly sort: RequestSort;
      readonly direction: Direction;
      readonly size: number;
    };

/**
 * `ExportSystemRequests`: the queue as a CSV or XLSX file. `ids` (comma-separated, at most 100, the
 * selection's cap) names the rows, in that order; an id that is not a request of the Market
 * refuses the whole file as not found. Without `ids` the list's view, search and filters pick the
 * rows, in the list's sort, at most 10,000 (more is `batch.too-large` with the total). Any key
 * that is neither a filter of the list nor `format`, `columns`, `ids`, `zone`, `sort` or
 * `direction` is refused. Times are written in `zone` (an IANA zone; the Market's when absent).
 */
export async function exportRequests(
  deps: SystemRequestsExportDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<ExportFile, ExportFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('query', 'type');
  }
  const query = input as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(query)) {
    if (!EXPORT_KEYS.has(key)) return invalid(Array.from(key).slice(0, 64).join(''), 'unknown');
  }
  const format = parseExportFormat(query['format']);
  if (!format.ok) return format;
  const columns = parseExportColumns(query['columns'], EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  let zone: string;
  if (query['zone'] !== undefined) {
    const given = parseZone(query['zone']);
    if (given === null) return invalid('zone', 'value');
    zone = given;
  } else {
    try {
      zone = deps.zone.zoneOf(context.market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }

  const now = deps.clock.now();
  const viewer: Viewer = { accountId: admin, reviews: await reviewableAreas(deps, context) };
  let selection: Selection;
  if (query['ids'] !== undefined) {
    if (typeof query['ids'] !== 'string' || query['ids'] === '') return invalid('ids', 'type');
    const listed = parseExportIds(query['ids'], MAX_BULK, (part) =>
      requestIdOf(part.trim().toLowerCase()),
    );
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly SystemRequest[], SystemRequestsFailure>(
      context.market,
      async () => ok(await deps.requests.findMany(context.market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const byId = new Map<string, SystemRequest>(found.value.map((row) => [row.id, row]));
    const rows: SystemRequest[] = [];
    for (const id of wanted) {
      const row = byId.get(id);
      if (row === undefined) return err({ code: 'system-requests.not-found' });
      rows.push(row);
    }
    selection = { kind: 'ids', rows };
  } else {
    const only: Record<string, unknown> = {};
    for (const field of [...MATCHING_FIELDS, 'sort', 'direction'] as const) {
      if (query[field] !== undefined) only[field] = query[field];
    }
    const parsed = parseQuery(only);
    if (!parsed.ok) return parsed;
    const filter = viewFilter(parsed.value.view, resolveNow(parsed.value.filter, now), viewer, now);
    let size = 0;
    if (filter !== null) {
      const counted = await deps.unitOfWork.run<
        { readonly found: number; readonly total: number },
        SystemRequestsFailure
      >(
        context.market,
        async () => {
          const found = await deps.requests.count(context.market, filter, LIST_EXPORT_MAX_ROWS + 1);
          if (found <= LIST_EXPORT_MAX_ROWS) return ok({ found, total: found });
          // Over the cap: a bounded count, so the panel can say how far to narrow.
          const total = await deps.requests.count(context.market, filter, EXPORT_TOTAL_CAP);
          return ok({ found, total });
        },
        { readOnly: true },
      );
      if (!counted.ok) return counted;
      const fits = checkExportSize(counted.value.found, counted.value.total);
      if (!fits.ok) return fits;
      size = counted.value.found;
    }
    selection = {
      kind: 'filter',
      filter,
      sort: parsed.value.sort,
      direction: parsed.value.direction,
      size,
    };
  }

  const chosen = columns.value;
  const header = [...HEADERS.base, ...chosen.flatMap((column) => HEADERS[column])];
  const rowsOf = async (page: readonly SystemRequest[]) => {
    // Names and subject labels from the other modules' facades, after the read (as the list).
    const { views } = await withLabels(
      deps,
      context,
      page.map((row) => requestView(row, viewer, now)),
    );
    return views.map((row): readonly ExportCell[] => [
      displayNumber(row.number),
      row.note,
      AREA_LABELS[row.area],
      RISK_LABELS[row.risk],
      STATUS_LABELS[row.status],
      ...chosen.flatMap((column) => cellsOf(column, row, zone, now)),
    ]);
  };
  const groups = (async function* () {
    yield [header];
    if (selection.kind === 'ids') {
      yield await rowsOf(selection.rows);
      return;
    }
    const { filter, sort, direction, size } = selection;
    if (filter === null) return;
    let after: Keyset | null = null;
    let written = 0;
    // Never more rows than were counted: a request opened while the file streams waits for the
    // next export rather than push the file past the cap.
    while (written < size) {
      const limit = Math.min(EXPORT_PAGE, size - written);
      const from = after;
      const read = await deps.unitOfWork.run<readonly SystemRequest[], SystemRequestsFailure>(
        context.market,
        async () =>
          ok(
            await deps.requests.page(context.market, filter, sort, direction, {
              kind: 'keyset',
              after: from,
              limit,
            }),
          ),
        { readOnly: true },
      );
      if (!read.ok) throw new Error(`system-requests.export: the read failed (${read.error.code})`);
      const page = read.value;
      if (page.length === 0) break;
      yield await rowsOf(page);
      written += page.length;
      after = keysetOf(sort, page[page.length - 1]!);
      if (page.length < limit) break;
    }
  })();

  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'system-requests',
      sheetName: 'System requests',
      day: now.toZonedDateTimeISO(zone).toPlainDate().toString(),
      groups,
      sheetWriter: deps.sheetWriter,
    }),
  );
}
