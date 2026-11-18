import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
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
import { REVIEWS_MODERATION_MODERATE, REVIEWS_MODERATION_REMOVE } from '../contracts/permissions';
import {
  EMPTY_MODERATION_FILTER,
  MODERATION_EXPORT_COLUMNS,
  MODERATION_LIST_VIEWS,
  MODERATION_SORT_KEYS,
  moderationActionsFor,
  type ModerationExportColumn,
  type ModerationFilter,
  type ModerationListView,
  type ModerationRowAction,
  type ModerationSort,
  type ModerationViewCounts,
} from '../domain/moderation-list';
import { adminAccountId } from './caller';
import { reviewView, type ModerationReviewView } from './moderation-flow';
import type { QueueRow } from './ports/review.repository';
import type { ReviewsDependencies } from './reviews-dependencies';

// The admin review moderation list as a super list (phase 3, list 18) and its export. A read:
// nothing here moderates. The row actions only name what the caller may do; each moderation use
// case checks its own key, the review's state and the admin's two-step proof when it runs, so the
// list offers no bulk action. The list works while the Market's reviews switch is off, like the
// queue: an admin must be able to take content down then. No author is ever in a row.

export const MODERATION_ROW_KEYS = [
  REVIEWS_MODERATION_MODERATE.key,
  REVIEWS_MODERATION_REMOVE.key,
] as const;

export interface ModerationListDependencies extends Pick<
  ReviewsDependencies,
  'unitOfWork' | 'reviews'
> {
  /** One probe per key of {@link MODERATION_ROW_KEYS}. */
  readonly probes: Readonly<Record<(typeof MODERATION_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const MODERATION_LIST_DEFAULT_PAGE_SIZE = 25;
export const MODERATION_LIST_MAX_PAGE_SIZE = 100;
export const MODERATION_EXPORT_MAX_IDS = 200;
const TEXT_MAX = 100;

const SELECTOR_KEYS = [
  'view',
  'minRating',
  'maxRating',
  'sellerId',
  'reportReason',
  'q',
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

export type ModerationListInput = Readonly<Record<string, unknown>>;

export type ModerationListFailure =
  | ListQueryFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'reviews.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface ModerationListRow extends ModerationReviewView {
  readonly actions: readonly ModerationRowAction[];
}

export interface ModerationListPage extends ListPage<ModerationListRow> {
  /** The count of each view for the Market, whatever the filter. */
  readonly counts: ModerationViewCounts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STARS = /^[1-5]$/;
const REASON = /^[a-z][a-z-]{0,39}$/;

const hasControl = (text: string): boolean =>
  Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

function parseSelector(record: ModerationListInput): Result<ModerationFilter, ListQueryFailure> {
  let view: ModerationListView = 'all';
  if (!absent(record['view'])) {
    const found = MODERATION_LIST_VIEWS.find((candidate) => candidate === record['view']);
    if (found === undefined) return listQueryInvalid('view', 'value');
    view = found;
  }
  let minRating: number | null = null;
  let maxRating: number | null = null;
  for (const key of ['minRating', 'maxRating'] as const) {
    const value = record[key];
    if (absent(value)) continue;
    if (typeof value !== 'string' || !STARS.test(value)) return listQueryInvalid(key, 'format');
    if (key === 'minRating') minRating = Number(value);
    else maxRating = Number(value);
  }
  if (minRating !== null && maxRating !== null && minRating > maxRating) {
    return listQueryInvalid('maxRating', 'range');
  }
  let sellerId: Id<'Seller'> | null = null;
  if (!absent(record['sellerId'])) {
    const parsed =
      typeof record['sellerId'] === 'string' ? parseId<'Seller'>(record['sellerId']) : null;
    if (parsed === null || !parsed.ok) return listQueryInvalid('sellerId', 'format');
    sellerId = parsed.value;
  }
  let reportReason: string | null = null;
  if (!absent(record['reportReason'])) {
    if (typeof record['reportReason'] !== 'string' || !REASON.test(record['reportReason'])) {
      return listQueryInvalid('reportReason', 'format');
    }
    reportReason = record['reportReason'];
  }
  let text: string | null = null;
  let anyId: string | null = null;
  if (!absent(record['q'])) {
    const raw = typeof record['q'] === 'string' ? record['q'].trim() : '';
    if (raw === '' || Array.from(raw).length > TEXT_MAX || hasControl(raw)) {
      return listQueryInvalid('q', 'format');
    }
    if (UUID.test(raw.toLowerCase())) anyId = raw.toLowerCase();
    else text = raw;
  }
  const range = parseInstantRange(record, '');
  if (!range.ok) return range;
  return ok({
    ...EMPTY_MODERATION_FILTER,
    view,
    minRating,
    maxRating,
    sellerId,
    reportReason,
    text,
    anyId,
    from: range.value.from,
    to: range.value.to,
  });
}

function unknownKey(record: ModerationListInput, allowed: ReadonlySet<string>): string | null {
  return Object.keys(record).find((key) => !allowed.has(key)) ?? null;
}

const SPEC = {
  sorts: MODERATION_SORT_KEYS,
  defaultSort: 'submitted',
  defaultDirection: () => 'desc' as const,
  defaultPageSize: MODERATION_LIST_DEFAULT_PAGE_SIZE,
  maxPageSize: MODERATION_LIST_MAX_PAGE_SIZE,
  maxPage: MAX_PAGED_ROWS,
} as const;

interface RowSubject {
  readonly status: ModerationReviewView['status'];
  readonly openReports: number;
}

/** The row Actions menu: Open always; each moderation by key and by what the status allows. */
const ROW_RULES: readonly RowActionRule<RowSubject>[] = [
  { id: 'open', permission: null },
  ...(['publish', 'hide', 'restore', 'dismiss-reports'] as const).map((id) => ({
    id,
    permission: REVIEWS_MODERATION_MODERATE.key,
    when: (row: RowSubject) => moderationActionsFor(row.status, row.openReports).includes(id),
  })),
  {
    id: 'remove',
    permission: REVIEWS_MODERATION_REMOVE.key,
    when: (row) => moderationActionsFor(row.status, row.openReports).includes('remove'),
  },
];

/**
 * The reviews of the moderation list: one page with its total (page numbers) or without
 * (Previous/Next), the view counts and each row's actions. Newest submitted first by default.
 */
export async function listModerationRows(
  deps: ModerationListDependencies,
  context: CallContext,
  input: ModerationListInput,
): Promise<Result<ModerationListPage, ModerationListFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
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
  const sort: ModerationSort = { key: query.value.sort, direction: query.value.direction };
  const { offset, limit } = pageWindow(query.value);
  const paging: ListPagingMode = query.value.paging;

  const read = await deps.unitOfWork.run<
    {
      readonly rows: readonly QueueRow[];
      readonly counts: ModerationViewCounts;
      readonly total: number | null;
    },
    never
  >(
    context.market,
    async () => {
      const rows = await deps.reviews.queryModerationList(
        context.market,
        filter,
        sort,
        offset,
        limit,
      );
      const counts = await deps.reviews.moderationViewCounts(context.market);
      const total =
        paging === 'pages'
          ? await deps.reviews.countModerationListWhere(context.market, filter)
          : null;
      return ok({ rows, counts, total });
    },
    { readOnly: true },
  );
  if (!read.ok) throw new Error('reviews.query-moderation-reviews: the read failed');

  const listed = listPage(read.value.rows, query.value, read.value.total);
  // Page numbers stop at 10,000 rows, so Previous/Next must not offer a page that is refused.
  const page =
    offset + query.value.pageSize >= MAX_PAGED_ROWS ? { ...listed, hasNext: false } : listed;
  const granted =
    page.items.length === 0 ? new Set<string>() : await heldKeys(context, deps.probes);
  return ok({
    ...page,
    items: page.items.map((row) => {
      const view = reviewView(row.review, row.openReports, row.signalCodes);
      return {
        ...view,
        actions: rowActions(
          { status: view.status, openReports: view.openReports },
          ROW_RULES,
          granted,
        ) as ModerationRowAction[],
      };
    }),
    counts: read.value.counts,
  });
}

// --- the export --------------------------------------------------------------------------------

export interface ModerationExportInput {
  readonly [key: string]: unknown;
}

const HEADERS: Readonly<Record<ModerationExportColumn | 'base', readonly string[]>> = {
  base: ['Rating', 'Title', 'Review', 'Status', 'Open reports', 'Submitted (UTC)'],
  'review-id': ['Review ID'],
  'product-id': ['Product ID'],
  'offer-id': ['Offer ID'],
  'seller-id': ['Seller ID'],
  locale: ['Language'],
  edited: ['Edited (UTC)'],
  signals: ['Signals'],
};

function cellsOf(column: ModerationExportColumn, view: ModerationReviewView): ExportCell[] {
  switch (column) {
    case 'review-id':
      return [view.id];
    case 'product-id':
      return [view.productId];
    case 'offer-id':
      return [view.offerId];
    case 'seller-id':
      return [view.sellerId];
    case 'locale':
      return [view.locale];
    case 'edited':
      return [view.editedAt?.toString() ?? ''];
    case 'signals':
      return [view.signalCodes.join(' ')];
  }
}

/**
 * The moderation list as a CSV or XLSX file: the chosen `ids` (at most 200; an id that is not in a
 * queue view refuses the whole request as not found) or what the selector keys match, at most
 * 10,000 (more is `batch.too-large` with the total), in the list's sort. With `ids` the selector
 * keys are ignored and the rows keep the order of the ids. The author is never in the file.
 */
export async function exportModerationRows(
  deps: ModerationListDependencies,
  context: CallContext,
  input: ModerationExportInput,
): Promise<Result<ExportFile, ModerationListFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const record = input ?? {};
  const stray = unknownKey(record, EXPORT_KEYS);
  if (stray !== null) return listQueryInvalid(stray, 'unknown');
  const format = parseExportFormat(record['format']);
  if (!format.ok) return format;
  const columns = parseExportColumns(record['columns'], MODERATION_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;

  let rows: readonly QueueRow[];
  if (record['ids'] !== undefined) {
    if (typeof record['ids'] !== 'string') return listQueryInvalid('ids', 'type');
    const listed = parseExportIds(record['ids'], MODERATION_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'ProductReview'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly QueueRow[], never>(
      market,
      async () => ok(await deps.reviews.findModerationRowsByIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) throw new Error('reviews.export-moderation-reviews: the read failed');
    const known = new Map<string, QueueRow>(found.value.map((row) => [row.review.id, row]));
    if (wanted.some((reviewId) => !known.has(reviewId))) return err({ code: 'reviews.not-found' });
    rows = wanted.map((reviewId) => known.get(reviewId) as QueueRow);
  } else {
    const query = parseListQuery(record, SPEC);
    if (!query.ok) return query;
    const selector = parseSelector(record);
    if (!selector.ok) return selector;
    const filter = selector.value;
    const sort: ModerationSort = { key: query.value.sort, direction: query.value.direction };
    const picked = await deps.unitOfWork.run<
      { readonly rows: readonly QueueRow[]; readonly total: number },
      never
    >(
      market,
      async () => {
        const found = await deps.reviews.queryModerationList(
          market,
          filter,
          sort,
          0,
          LIST_EXPORT_MAX_ROWS + 1,
        );
        const total =
          found.length <= LIST_EXPORT_MAX_ROWS
            ? found.length
            : await deps.reviews.countModerationListWhere(market, filter);
        return ok({ rows: found, total });
      },
      { readOnly: true },
    );
    if (!picked.ok) throw new Error('reviews.export-moderation-reviews: the read failed');
    const size = checkExportSize(picked.value.rows.length, picked.value.total);
    if (!size.ok) return size;
    rows = picked.value.rows;
  }

  const views = rows.map((row) => reviewView(row.review, row.openReports, row.signalCodes));
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'review-moderation',
      sheetName: 'Review moderation',
      day: deps.clock.now().toString().slice(0, 10),
      groups: exportRows(views, columns.value),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

/** The header and then every line as one group, read as an async sequence (nothing is awaited). */
function exportRows(
  views: readonly ModerationReviewView[],
  columns: readonly ModerationExportColumn[],
): AsyncIterable<readonly (readonly ExportCell[])[]> {
  const groups: (readonly (readonly ExportCell[])[])[] = [
    [[...HEADERS.base, ...columns.flatMap((column) => HEADERS[column])]],
    views.map((view) => [
      view.rating,
      view.title ?? '',
      view.body ?? '',
      view.status,
      view.openReports,
      view.createdAt.toString(),
      ...columns.flatMap((column) => cellsOf(column, view)),
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
