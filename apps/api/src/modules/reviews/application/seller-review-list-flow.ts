import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
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
import { REVIEWS_SELLER_REPLY, REVIEWS_SELLER_REPORT } from '../contracts/permissions';
import {
  EMPTY_SELLER_REVIEW_FILTER,
  SELLER_REVIEW_EXPORT_COLUMNS,
  SELLER_REVIEW_SORT_KEYS,
  SELLER_REVIEW_VIEWS,
  sellerReviewViewFilter,
  type SellerReviewExportColumn,
  type SellerReviewFilter,
  type SellerReviewRowAction,
  type SellerReviewSort,
  type SellerReviewView_,
  type SellerReviewViewCounts,
} from '../domain/seller-review-list';
import { isActingAs } from './caller';
import { activeSettings } from './market-switch';
import type { ReviewsFailure } from './failures';
import type { SellerReviewRow } from './ports/review.repository';
import type { ReviewsDependencies } from './reviews-dependencies';
import { reviewView, sellerOf, type SellerReviewView } from './seller-flow';

// The shop's review list as a super list (phase 3, list 32) and its export. A read: nothing here
// replies or reports. The row actions only name what the caller may do; the reply and the report
// use cases check their own key, the review's state and the acting-as rule again when they run.
// A seller never sees the buyer: only the order reference, as in the older cursor list.

export const SELLER_REVIEW_ROW_KEYS = [
  REVIEWS_SELLER_REPLY.key,
  REVIEWS_SELLER_REPORT.key,
] as const;

export interface SellerReviewListDependencies extends Pick<
  ReviewsDependencies,
  'unitOfWork' | 'reviews' | 'settings' | 'policy'
> {
  /** One probe per key of {@link SELLER_REVIEW_ROW_KEYS}. */
  readonly probes: Readonly<Record<(typeof SELLER_REVIEW_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const SELLER_REVIEW_LIST_DEFAULT_PAGE_SIZE = 25;
export const SELLER_REVIEW_LIST_MAX_PAGE_SIZE = 100;
export const SELLER_REVIEW_EXPORT_MAX_IDS = 200;
const TEXT_MAX = 100;

const SELECTOR_KEYS = ['view', 'reply', 'minRating', 'maxRating', 'q', 'from', 'to'] as const;
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

export type SellerReviewListInput = Readonly<Record<string, unknown>>;

export type SellerReviewListFailure =
  | ListQueryFailure
  | ReviewsFailure
  | { readonly code: 'reviews.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface SellerReviewListRow extends SellerReviewView {
  readonly actions: readonly SellerReviewRowAction[];
}

export interface SellerReviewListPage extends ListPage<SellerReviewListRow> {
  /** The count of each view for the shop, whatever the filter. */
  readonly counts: SellerReviewViewCounts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STARS = /^[1-5]$/;
/** A control character (tab and new line included) is refused in a search. */
const hasControl = (text: string): boolean =>
  Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

function parseSelector(
  record: SellerReviewListInput,
): Result<SellerReviewFilter, ListQueryFailure> {
  let view: SellerReviewView_ = 'all';
  if (!absent(record['view'])) {
    const found = SELLER_REVIEW_VIEWS.find((candidate) => candidate === record['view']);
    if (found === undefined) return listQueryInvalid('view', 'value');
    view = found;
  }
  const base = sellerReviewViewFilter(view);
  let { reply, maxRating } = base;
  let minRating: number | null = null;
  if (!absent(record['reply'])) {
    if (record['reply'] !== 'none' && record['reply'] !== 'published') {
      return listQueryInvalid('reply', 'value');
    }
    reply = record['reply'];
  }
  for (const key of ['minRating', 'maxRating'] as const) {
    const value = record[key];
    if (absent(value)) continue;
    if (typeof value !== 'string' || !STARS.test(value)) return listQueryInvalid(key, 'format');
    if (key === 'minRating') minRating = Number(value);
    else maxRating = maxRating === null ? Number(value) : Math.min(maxRating, Number(value));
  }
  if (minRating !== null && maxRating !== null && minRating > maxRating) {
    return listQueryInvalid('maxRating', 'range');
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
    ...EMPTY_SELLER_REVIEW_FILTER,
    reply,
    minRating,
    maxRating,
    text,
    anyId,
    from: range.value.from,
    to: range.value.to,
  });
}

function unknownKey(record: SellerReviewListInput, allowed: ReadonlySet<string>): string | null {
  return Object.keys(record).find((key) => !allowed.has(key)) ?? null;
}

/** Page and Previous/Next both read by offset: a page past 10,000 rows is refused. */
const SPEC = {
  sorts: SELLER_REVIEW_SORT_KEYS,
  defaultSort: 'published',
  defaultDirection: () => 'desc' as const,
  defaultPageSize: SELLER_REVIEW_LIST_DEFAULT_PAGE_SIZE,
  maxPageSize: SELLER_REVIEW_LIST_MAX_PAGE_SIZE,
  maxPage: MAX_PAGED_ROWS,
} as const;

/** The row Actions menu: Open always; Reply, Edit reply and Report by key, state and session. */
function rulesFor(actingAs: boolean, now: number): readonly RowActionRule<SellerReviewView>[] {
  return [
    { id: 'open', permission: null },
    {
      id: 'reply',
      permission: REVIEWS_SELLER_REPLY.key,
      when: (row) => !actingAs && row.reply === null,
    },
    {
      id: 'edit-reply',
      permission: REVIEWS_SELLER_REPLY.key,
      when: (row) =>
        !actingAs && row.reply !== null && now < row.reply.editableUntil.epochMilliseconds,
    },
    { id: 'report', permission: REVIEWS_SELLER_REPORT.key, when: () => !actingAs },
  ];
}

/**
 * The shop's published reviews for the list: one page with its total (page numbers) or without
 * (Previous/Next), the view counts and each row's actions. Newest published first by default.
 */
export async function listSellerReviewRows(
  deps: SellerReviewListDependencies,
  context: CallContext,
  input: SellerReviewListInput,
): Promise<Result<SellerReviewListPage, SellerReviewListFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
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
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const days = switched.value.replyEditWindowDays;
  const sort: SellerReviewSort = { key: query.value.sort, direction: query.value.direction };
  const { offset, limit } = pageWindow(query.value);
  const paging: ListPagingMode = query.value.paging;

  const read = await deps.unitOfWork.run<
    {
      readonly rows: readonly SellerReviewRow[];
      readonly counts: SellerReviewViewCounts;
      readonly total: number | null;
    },
    never
  >(
    context.market,
    async () => {
      const rows = await deps.reviews.querySellerReviews(
        context.market,
        sellerId,
        filter,
        sort,
        offset,
        limit,
      );
      const counts = await deps.reviews.sellerReviewViewCounts(context.market, sellerId);
      const total =
        paging === 'pages'
          ? await deps.reviews.countSellerReviewsWhere(context.market, sellerId, filter)
          : null;
      return ok({ rows, counts, total });
    },
    { readOnly: true },
  );
  if (!read.ok) throw new Error('reviews.query-seller-reviews: the read failed');

  const page = listPage(read.value.rows, query.value, read.value.total);
  const granted =
    page.items.length === 0 || isActingAs(context)
      ? new Set<string>()
      : await heldKeys(context, deps.probes);
  const rules = rulesFor(isActingAs(context), deps.clock.now().epochMilliseconds);
  return ok({
    ...page,
    items: page.items.map((row) => {
      const view = reviewView(row, days);
      return {
        ...view,
        actions: rowActions(view, rules, granted) as SellerReviewRowAction[],
      };
    }),
    counts: read.value.counts,
  });
}

// --- the export --------------------------------------------------------------------------------

export interface SellerReviewExportInput {
  readonly [key: string]: unknown;
}

const HEADERS: Readonly<Record<SellerReviewExportColumn | 'base', readonly string[]>> = {
  base: ['Rating', 'Title', 'Review', 'Published (UTC)'],
  'review-id': ['Review ID'],
  'order-ref': ['Order reference'],
  'product-id': ['Product ID'],
  'offer-id': ['Offer ID'],
  locale: ['Language'],
  reply: ['Reply'],
  replied: ['Replied (UTC)'],
};

function cellsOf(column: SellerReviewExportColumn, view: SellerReviewView): ExportCell[] {
  switch (column) {
    case 'review-id':
      return [view.id];
    case 'order-ref':
      return [view.orderRef ?? ''];
    case 'product-id':
      return [view.productId];
    case 'offer-id':
      return [view.offerId];
    case 'locale':
      return [view.locale];
    case 'reply':
      return [view.reply?.body ?? ''];
    case 'replied':
      return [view.reply?.createdAt.toString() ?? ''];
  }
}

/**
 * The shop's reviews of the list as a CSV or XLSX file: the chosen `ids` (at most 200; an id that
 * is not a published review of the shop refuses the whole request as not found) or what the
 * selector keys match, at most 10,000 (more is `batch.too-large` with the total), in the list's
 * sort. The buyer is never in the file: only the order reference, when that column is chosen.
 */
export async function exportSellerReviewRows(
  deps: SellerReviewListDependencies,
  context: CallContext,
  input: SellerReviewExportInput,
): Promise<Result<ExportFile, SellerReviewListFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const record = input ?? {};
  const stray = unknownKey(record, EXPORT_KEYS);
  if (stray !== null) return listQueryInvalid(stray, 'unknown');
  const format = parseExportFormat(record['format']);
  if (!format.ok) return format;
  const columns = parseExportColumns(record['columns'], SELLER_REVIEW_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const days = switched.value.replyEditWindowDays;
  const { market } = context;

  let rows: readonly SellerReviewRow[];
  if (!absent(record['ids'])) {
    if (typeof record['ids'] !== 'string') return listQueryInvalid('ids', 'type');
    const listed = parseExportIds(record['ids'], SELLER_REVIEW_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'ProductReview'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly SellerReviewRow[], never>(
      market,
      async () => ok(await deps.reviews.findSellerReviewsByIds(market, sellerId, wanted)),
      { readOnly: true },
    );
    if (!found.ok) throw new Error('reviews.export-seller-reviews: the read failed');
    const known = new Map<string, SellerReviewRow>(found.value.map((row) => [row.review.id, row]));
    if (wanted.some((reviewId) => !known.has(reviewId))) return err({ code: 'reviews.not-found' });
    rows = wanted.map((reviewId) => known.get(reviewId) as SellerReviewRow);
  } else {
    const query = parseListQuery(record, SPEC);
    if (!query.ok) return query;
    const selector = parseSelector(record);
    if (!selector.ok) return selector;
    const filter = selector.value;
    const sort: SellerReviewSort = { key: query.value.sort, direction: query.value.direction };
    const picked = await deps.unitOfWork.run<
      { readonly rows: readonly SellerReviewRow[]; readonly total: number },
      never
    >(
      market,
      async () => {
        const found = await deps.reviews.querySellerReviews(
          market,
          sellerId,
          filter,
          sort,
          0,
          LIST_EXPORT_MAX_ROWS + 1,
        );
        const total =
          found.length <= LIST_EXPORT_MAX_ROWS
            ? found.length
            : await deps.reviews.countSellerReviewsWhere(market, sellerId, filter);
        return ok({ rows: found, total });
      },
      { readOnly: true },
    );
    if (!picked.ok) throw new Error('reviews.export-seller-reviews: the read failed');
    const size = checkExportSize(picked.value.rows.length, picked.value.total);
    if (!size.ok) return size;
    rows = picked.value.rows;
  }

  const lines = rows.map((row) => reviewView(row, days));
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'reviews',
      sheetName: 'Reviews',
      day: deps.clock.now().toString().slice(0, 10),
      groups: exportRows(lines, columns.value),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

/** The header and then every line as one group, read as an async sequence (nothing is awaited). */
function exportRows(
  views: readonly SellerReviewView[],
  columns: readonly SellerReviewExportColumn[],
): AsyncIterable<readonly (readonly ExportCell[])[]> {
  const groups: (readonly (readonly ExportCell[])[])[] = [
    [[...HEADERS.base, ...columns.flatMap((column) => HEADERS[column])]],
    views.map((view) => [
      view.rating,
      view.title ?? '',
      view.body ?? '',
      view.publishedAt?.toString() ?? '',
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
