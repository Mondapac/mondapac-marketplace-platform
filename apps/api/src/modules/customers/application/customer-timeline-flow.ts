import { err, ok, Temporal } from '@mondapac/shared-kernel';
import { localDayEnd, localDayStart } from '../domain/local-day';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { CSV_BOM, csvLine } from '@mondapac/platform-import';
import {
  listPage,
  pageWindow,
  parseListQuery,
  MAX_PAGED_ROWS,
  type ListPage,
} from '../../../platform/list-query';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import { CustomerPageOpened, CustomerTimelineExported } from '../domain/audit';
import {
  categoryOf,
  CONSENT_EVENT_KINDS,
  kindsOf,
  REVIEW_EVENT_KINDS,
  TIMELINE_CATEGORIES,
  TIMELINE_KINDS,
  type TimelineCategory,
  type TimelineEntry,
  type TimelineKind,
} from '../domain/customer-timeline';
import type { CustomerManagementDependencies } from './customer-management-dependencies';
import {
  adminAccountOf,
  invalidField,
  isRecord,
  type ListValidationFailure,
} from './customer-list-flow';
import { accountIdOf } from './customer-page-flow';
import { adminNames } from './customer-notes-flow';
import type { TimelineQuery } from './ports/customer-timeline.repository';
import { XLSX_CONTENT_TYPE } from './ports/sheet-writer';

// A customer's activity timeline (phase 2, PR 2a): a super list scoped to one customer (CLAUDE.md
// rule 14): filter by event type (a category or exact kinds) and date, sort by time, page numbers
// with a total or Previous and Next (the Market's List paging setting), and the export. Every
// read is an open of the customer's page and writes its audit row (tab `activity`).

export type TimelineFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'customers.customer-not-found' }
  | { readonly code: 'second-factor.required'; readonly actionKey?: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey?: string }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number }
  | ListValidationFailure;

/** One entry as the page shows it: codes and ids, and the admin's name for an admin action. */
export interface TimelineEntryView {
  readonly entryId: string;
  readonly kind: TimelineKind;
  readonly category: TimelineCategory;
  readonly occurredAt: string;
  readonly ref: { readonly type: string; readonly id: string } | null;
  readonly actor: { readonly accountId: string; readonly name: string | null } | null;
  readonly detail: string | null;
}

const SPEC = {
  sorts: ['occurred'] as const,
  defaultSort: 'occurred' as const,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxPage: Math.ceil(MAX_PAGED_ROWS / 25),
};

const FILTER_KEYS = ['category', 'kinds', 'from', 'to'] as const;

/**
 * Reads the filters of a timeline request (closed). `from` and `to` are calendar days in `zone`
 * (the admin's own zone, else the Market's; ADR-0005): [from's first instant, the first instant
 * after to).
 */
export function timelineFiltersOf(
  accountId: Id<'Account'>,
  raw: unknown,
  zone: string,
): Result<TimelineQuery, ListValidationFailure> {
  if (raw === undefined || raw === null) {
    return ok({ accountId, kinds: null, from: null, to: null });
  }
  if (!isRecord(raw)) return invalidField('filters', 'type');
  for (const key of Object.keys(raw)) {
    if (!(FILTER_KEYS as readonly string[]).includes(key)) {
      return invalidField(`filters.${key}`, 'unknown');
    }
  }
  let kinds: TimelineKind[] | null = null;
  if (raw['category'] !== undefined && raw['category'] !== null && raw['category'] !== '') {
    const category = TIMELINE_CATEGORIES.find((known) => known === raw['category']);
    if (category === undefined) return invalidField('filters.category', 'value');
    kinds = [...kindsOf(category)];
  }
  if (raw['kinds'] !== undefined && raw['kinds'] !== null) {
    const list = raw['kinds'];
    if (!Array.isArray(list) || list.length === 0 || list.length > TIMELINE_KINDS.length) {
      return invalidField('filters.kinds', 'type');
    }
    const picked: TimelineKind[] = [];
    for (const value of list as unknown[]) {
      const kind = TIMELINE_KINDS.find((known) => known === value);
      if (kind === undefined) return invalidField('filters.kinds', 'value');
      picked.push(kind);
    }
    kinds = kinds === null ? picked : kinds.filter((kind) => picked.includes(kind));
  }
  let from: Temporal.Instant | null = null;
  let to: Temporal.Instant | null = null;
  if (raw['from'] !== undefined && raw['from'] !== null && raw['from'] !== '') {
    from = typeof raw['from'] === 'string' ? localDayStart(raw['from'], zone) : null;
    if (from === null) return invalidField('filters.from', 'format');
  }
  if (raw['to'] !== undefined && raw['to'] !== null && raw['to'] !== '') {
    to = typeof raw['to'] === 'string' ? localDayEnd(raw['to'], zone) : null;
    if (to === null) return invalidField('filters.to', 'format');
  }
  if (from !== null && to !== null && Temporal.Instant.compare(to, from) <= 0) {
    return invalidField('filters.to', 'range');
  }
  return ok({ accountId, kinds, from, to });
}

const REVIEW_KINDS: readonly TimelineKind[] = REVIEW_EVENT_KINDS;
const CONSENT_KINDS: readonly TimelineKind[] = CONSENT_EVENT_KINDS;

/**
 * The query the caller may run. The review kinds only with reviews' own key
 * `reviews.customer-review.view` as well (security review L1), the consent kind only with legal's
 * `legal.customer-consent.view` (phase 2b, part 4: the count of consent entries tells the current
 * value). Without a key its kinds leave the query itself (every kind but those, or the requested
 * kinds less those), so a page and its total agree; a filter on those kinds only is an empty list
 * rather than an error. A check the gate cannot answer is `access.unavailable`. Asked before the
 * unit opens: the gate reads in a unit of its own.
 */
async function visibleQuery(
  deps: CustomerManagementDependencies,
  context: CallContext,
  query: TimelineQuery,
): Promise<Result<TimelineQuery, { readonly code: 'access.unavailable' }>> {
  const hidden: TimelineKind[] = [];
  for (const [probe, kinds] of [
    [deps.reviewEventsCheck, REVIEW_KINDS],
    [deps.consentEventsCheck, CONSENT_KINDS],
  ] as const) {
    const answer = await probe.execute(context, {});
    if (answer.ok) continue;
    if (answer.error.code !== 'access.denied') return err({ code: 'access.unavailable' });
    hidden.push(...kinds);
  }
  if (hidden.length === 0) return ok(query);
  const kinds = (query.kinds ?? TIMELINE_KINDS).filter((kind) => !hidden.includes(kind));
  return ok({ ...query, kinds });
}

async function viewsOf(
  deps: CustomerManagementDependencies,
  context: CallContext,
  entries: readonly TimelineEntry[],
): Promise<readonly TimelineEntryView[]> {
  const names = await adminNames(
    deps,
    context,
    entries.flatMap((entry) => (entry.actorAccountId === null ? [] : [entry.actorAccountId])),
  );
  return entries.map((entry) => ({
    entryId: entry.id,
    kind: entry.kind,
    category: categoryOf(entry.kind),
    occurredAt: entry.occurredAt.toString(),
    ref: entry.ref,
    actor:
      entry.actorAccountId === null
        ? null
        : { accountId: entry.actorAccountId, name: names.get(entry.actorAccountId) ?? null },
    detail: entry.detail,
  }));
}

const LIST_KEYS = ['accountId', 'filters', 'sort', 'direction', 'page', 'pageSize', 'paging'];

/**
 * One page of the customer's timeline. The read and the page audit row are one unit, so a page
 * that cannot be audited is not shown; another Market's customer, or none, is
 * `customers.customer-not-found`.
 */
export async function readTimeline(
  deps: CustomerManagementDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<ListPage<TimelineEntryView>, TimelineFailure>> {
  if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input)) {
    if (!LIST_KEYS.includes(key)) return invalidField(key, 'unknown');
  }
  const accountId = accountIdOf(input['accountId']);
  if (accountId === null) return err({ code: 'customers.customer-not-found' });
  const filters = timelineFiltersOf(
    accountId,
    input['filters'],
    await deps.dayZone.zoneOf(context),
  );
  if (!filters.ok) return filters;
  const list = parseListQuery(input, SPEC);
  if (!list.ok) return list;
  const query = await visibleQuery(deps, context, filters.value);
  if (!query.ok) return query;
  const window = pageWindow(list.value);
  const read = await deps.unitOfWork.run<
    { readonly rows: readonly TimelineEntry[]; readonly total: number | null },
    TimelineFailure
  >(context.market, async () => {
    const [row] = await deps.listReader.rowsByIds(context.market, [accountId]);
    if (row === undefined) return err({ code: 'customers.customer-not-found' });
    const [rows, total] = await Promise.all([
      deps.timeline.page(context.market, query.value, list.value.direction, window),
      list.value.paging === 'pages'
        ? deps.timeline.count(context.market, query.value)
        : Promise.resolve(null),
    ]);
    await deps.audit.record(
      context,
      CustomerPageOpened.entry(accountId, { after: { tab: 'activity' } }),
    );
    return ok({ rows, total });
  });
  if (!read.ok) return read;
  const page = listPage(read.value.rows, list.value, read.value.total);
  return ok({ ...page, items: await viewsOf(deps, context, page.items) });
}

/** The columns of the timeline export. */
const EXPORT_HEADER = [
  'Occurred at',
  'Event',
  'Category',
  'Reference type',
  'Reference',
  'By',
  'Detail',
];
const EXPORT_MAX = 10_000;

export interface TimelineExportOutput {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

/**
 * The customer's timeline (with the request's filters) as a CSV or XLSX file, at most 10,000
 * entries (more is refused whole). Needs a fresh two-step proof of `customers.customers.export`,
 * spent in the unit that reads the entries and writes the audit row.
 */
export async function exportTimeline(
  deps: CustomerManagementDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<TimelineExportOutput, TimelineFailure>> {
  if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input)) {
    if (!['accountId', 'filters', 'format', 'direction'].includes(key)) {
      return invalidField(key, 'unknown');
    }
  }
  const format = input['format'] ?? 'csv';
  if (format !== 'csv' && format !== 'xlsx') return invalidField('format', 'value');
  const direction = input['direction'] ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') return invalidField('direction', 'value');
  const accountId = accountIdOf(input['accountId']);
  if (accountId === null) return err({ code: 'customers.customer-not-found' });
  const filters = timelineFiltersOf(
    accountId,
    input['filters'],
    await deps.dayZone.zoneOf(context),
  );
  if (!filters.ok) return filters;
  const query = await visibleQuery(deps, context, filters.value);
  if (!query.ok) return query;
  const now = deps.clock.now();
  const read = await deps.unitOfWork.run<readonly TimelineEntry[], TimelineFailure>(
    context.market,
    async () => {
      const spent = await deps.stepUp.consume(context, CUSTOMERS_EXPORT_STEP_UP);
      if (!spent.ok) {
        const refusal = spent.error;
        if (
          refusal.code === 'second-factor.required' ||
          refusal.code === 'second-factor.enrolment-required'
        ) {
          return err({ code: refusal.code, actionKey: refusal.actionKey });
        }
        return err({
          code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied',
        });
      }
      const [row] = await deps.listReader.rowsByIds(context.market, [accountId]);
      if (row === undefined) return err({ code: 'customers.customer-not-found' });
      const rows = await deps.timeline.page(context.market, query.value, direction, {
        offset: 0,
        limit: EXPORT_MAX + 1,
      });
      if (rows.length > EXPORT_MAX) {
        return err({
          code: 'batch.too-large',
          max: EXPORT_MAX,
          total: await deps.timeline.count(context.market, query.value),
        });
      }
      await deps.audit.record(
        context,
        CustomerTimelineExported.entry(accountId, {
          after: {
            format,
            rowCount: rows.length,
            stepUpSessionId: spent.value.sessionId,
            stepUpVerifiedAt: spent.value.verifiedAt,
          },
        }),
      );
      return ok(rows);
    },
  );
  if (!read.ok) return read;
  const views = await viewsOf(deps, context, read.value);
  const lines: (readonly string[])[] = [
    EXPORT_HEADER,
    ...views.map((view) => [
      view.occurredAt,
      view.kind,
      view.category,
      view.ref?.type ?? '',
      view.ref?.id ?? '',
      view.actor === null ? '' : (view.actor.name ?? view.actor.accountId),
      view.detail ?? '',
    ]),
  ];
  const day = now.toString().slice(0, 10);
  if (format === 'xlsx') {
    return ok({
      filename: `customer-activity-${day}.xlsx`,
      contentType: XLSX_CONTENT_TYPE,
      chunks: deps.sheetWriter.xlsx('Activity', fromArray(lines)),
    });
  }
  return ok({
    filename: `customer-activity-${day}.csv`,
    contentType: 'text/csv; charset=utf-8',
    chunks: fromArray([CSV_BOM + lines.map((line) => csvLine(line)).join('')]),
  });
}

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield await Promise.resolve(item);
}
