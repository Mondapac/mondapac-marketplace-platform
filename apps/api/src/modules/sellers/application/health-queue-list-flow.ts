import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import {
  buildExportFile,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
  type ExportCell,
  type ExportFile,
  type SheetWriter,
} from '../../../platform/list-export';
import {
  listPage,
  listQueryInvalid,
  pageWindow,
  parseListQuery,
  MAX_PAGED_ROWS,
  type ListPage,
  type ListQueryFailure,
} from '../../../platform/list-query';
import {
  compareHealthQueue,
  EMPTY_HEALTH_QUEUE_FILTER,
  HEALTH_QUEUE_EXPORT_COLUMNS,
  HEALTH_QUEUE_ROW_ACTIONS,
  HEALTH_QUEUE_SORT_KEYS,
  HEALTH_QUEUE_VIEWS,
  healthQueueMatches,
  SEARCH_MAX,
  SEARCH_MIN,
  type HealthQueueExportColumn,
  type HealthQueueFilter,
  type HealthQueueRowAction,
  type HealthQueueSort,
  type HealthQueueView,
} from '../domain/health-queue-list';
import { SELLER_HEALTH_METRICS, type SellerHealthMetric } from '../domain/seller-health';
import { UNHEALTHY_QUEUE_MAX } from './ports/seller-health.store';
import {
  readHealthQueue,
  type SellerHealthQueueDependencies,
  type SellerHealthQueueFailure,
  type SellerHealthQueueItem,
} from './use-cases/seller-health-queue.use-case';

// The admin "Needs a look" queue as a super list (phase 3, list 16) and its export. A read:
// health only informs and nothing here acts on a seller. The one row action is Open (the seller's
// file). No bulk action: there is none to run on a seller from health. The queue holds at most
// 200 sellers; `truncated` says when more were unhealthy than it holds.

export interface HealthQueueListDependencies extends SellerHealthQueueDependencies {
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const HEALTH_LIST_DEFAULT_PAGE_SIZE = 25;
export const HEALTH_LIST_MAX_PAGE_SIZE = 100;
export const HEALTH_EXPORT_MAX_IDS = 200;

const SELECTOR_KEYS = ['view', 'metric', 'q', 'sellerId', 'minScore', 'maxScore'] as const;
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

export type HealthQueueListInput = Readonly<Record<string, unknown>>;

export type HealthQueueListFailure =
  | ListQueryFailure
  | SellerHealthQueueFailure
  | { readonly code: 'file.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface HealthQueueListRow extends SellerHealthQueueItem {
  readonly actions: readonly HealthQueueRowAction[];
}

export type HealthQueueViewCounts = Readonly<Record<HealthQueueView, number>>;

export interface HealthQueueListPage extends ListPage<HealthQueueListRow> {
  /** The count of each view among the queue read, whatever the filter. */
  readonly counts: HealthQueueViewCounts;
  /** True when more sellers were unhealthy than the queue holds. */
  readonly truncated: boolean;
}

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';
const SCORE = /^(100|[1-9]?[0-9])$/;
const SEARCH_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function parseSelector(record: HealthQueueListInput): Result<HealthQueueFilter, ListQueryFailure> {
  let view: HealthQueueView = 'all';
  if (!absent(record['view'])) {
    const found = HEALTH_QUEUE_VIEWS.find((candidate) => candidate === record['view']);
    if (found === undefined) return listQueryInvalid('view', 'value');
    view = found;
  }
  let metric: SellerHealthMetric | null = view === 'all' ? null : view;
  if (!absent(record['metric'])) {
    const found = SELLER_HEALTH_METRICS.find((candidate) => candidate === record['metric']);
    if (found === undefined) return listQueryInvalid('metric', 'value');
    if (view !== 'all' && view !== found) return listQueryInvalid('metric', 'conflict');
    metric = found;
  }
  let prefix: string | null = null;
  if (!absent(record['q'])) {
    const text = typeof record['q'] === 'string' ? record['q'].trim().toLowerCase() : '';
    if (text.length < SEARCH_MIN || text.length > SEARCH_MAX || SEARCH_FORBIDDEN.test(text)) {
      return listQueryInvalid('q', 'format');
    }
    prefix = text;
  }
  let sellerId: string | null = null;
  if (!absent(record['sellerId'])) {
    const parsed =
      typeof record['sellerId'] === 'string' ? parseId<'Seller'>(record['sellerId']) : null;
    if (parsed === null || !parsed.ok) return listQueryInvalid('sellerId', 'format');
    sellerId = parsed.value;
  }
  const scores: Record<'minScore' | 'maxScore', number | null> = { minScore: null, maxScore: null };
  for (const key of ['minScore', 'maxScore'] as const) {
    const value = record[key];
    if (absent(value)) continue;
    if (typeof value !== 'string' || !SCORE.test(value)) return listQueryInvalid(key, 'format');
    scores[key] = Number(value);
  }
  if (scores.minScore !== null && scores.maxScore !== null && scores.minScore > scores.maxScore) {
    return listQueryInvalid('maxScore', 'range');
  }
  return ok({ ...EMPTY_HEALTH_QUEUE_FILTER, metric, prefix, sellerId, ...scores });
}

const unknownKey = (record: HealthQueueListInput, allowed: ReadonlySet<string>): string | null =>
  Object.keys(record).find((key) => !allowed.has(key)) ?? null;

const SPEC = {
  sorts: HEALTH_QUEUE_SORT_KEYS,
  // The queue's own order: worst score first.
  defaultSort: 'score',
  defaultDirection: (sort: string) => (sort === 'score' || sort === 'name' ? 'asc' : 'desc'),
  defaultPageSize: HEALTH_LIST_DEFAULT_PAGE_SIZE,
  maxPageSize: HEALTH_LIST_MAX_PAGE_SIZE,
  maxPage: MAX_PAGED_ROWS,
} as const;

function select(
  items: readonly SellerHealthQueueItem[],
  filter: HealthQueueFilter,
  sort: HealthQueueSort,
): SellerHealthQueueItem[] {
  return items
    .filter((row) => healthQueueMatches(row, filter))
    .sort((a, b) => compareHealthQueue(a, b, sort));
}

function countsOf(items: readonly SellerHealthQueueItem[]): HealthQueueViewCounts {
  const counts = { all: items.length } as Record<HealthQueueView, number>;
  for (const metric of SELLER_HEALTH_METRICS) {
    counts[metric] = items.filter((row) => row.lowestMetric === metric).length;
  }
  return counts;
}

/**
 * The unhealthy sellers of the Market: one page with its total (page numbers) or without
 * (Previous/Next), the view counts and each row's actions. Worst score first by default.
 */
export async function listHealthQueue(
  deps: HealthQueueListDependencies,
  context: CallContext,
  input: HealthQueueListInput,
): Promise<Result<HealthQueueListPage, HealthQueueListFailure>> {
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
  const sort: HealthQueueSort = { key: query.value.sort, direction: query.value.direction };

  const queue = await readHealthQueue(deps, context);
  if (!queue.ok) return queue;
  const matching = select(queue.value.items, selector.value, sort);
  const { offset, limit } = pageWindow(query.value);
  const page = listPage(matching.slice(offset, offset + limit), query.value, matching.length);
  return ok({
    ...page,
    items: page.items.map((row) => ({ ...row, actions: [...HEALTH_QUEUE_ROW_ACTIONS] })),
    counts: countsOf(queue.value.items),
    truncated: queue.value.truncated,
  });
}

// --- the export --------------------------------------------------------------------------------

const BASE_HEADERS = ['Store', 'Slug', 'Score', 'Lowest metric'] as const;
const HEADERS: Readonly<Record<HealthQueueExportColumn, string>> = {
  'seller-id': 'Seller ID',
  day: 'Measured on',
};

function cellOf(column: HealthQueueExportColumn, row: SellerHealthQueueItem): ExportCell {
  return column === 'seller-id' ? row.sellerId : row.day;
}

/** The groups of rows as the async sequence the shared export builder reads. */
function asyncGroups<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let next = 0;
      return {
        next: () =>
          Promise.resolve(
            next < items.length
              ? { value: items[next++] as T, done: false as const }
              : { value: undefined, done: true as const },
          ),
      };
    },
  };
}

/**
 * The queue of the list as a CSV or XLSX file: the chosen `ids` (seller ids, at most 200; an id
 * that is not in the queue refuses the whole request as not found; no filter or sort beside them)
 * or what the selector keys match, in the list's sort. The selector form is refused with
 * `batch.too-large` when the queue was cut (`truncated`), so a file never silently misses sellers.
 */
export async function exportHealthQueue(
  deps: HealthQueueListDependencies,
  context: CallContext,
  input: HealthQueueListInput,
): Promise<Result<ExportFile, HealthQueueListFailure>> {
  const record = input ?? {};
  const stray = unknownKey(record, EXPORT_KEYS);
  if (stray !== null) return listQueryInvalid(stray, 'unknown');
  const format = parseExportFormat(record['format']);
  if (!format.ok) return format;
  const columns = parseExportColumns(record['columns'], HEALTH_QUEUE_EXPORT_COLUMNS);
  if (!columns.ok) return columns;

  const queue = await readHealthQueue(deps, context);
  if (!queue.ok) return queue;
  let rows: SellerHealthQueueItem[];
  if (!absent(record['ids'])) {
    if (typeof record['ids'] !== 'string') return listQueryInvalid('ids', 'type');
    const clash = [...SELECTOR_KEYS, 'sort', 'direction'].find((key) => !absent(record[key]));
    if (clash !== undefined) return listQueryInvalid(clash, 'with-ids');
    const listed = parseExportIds(record['ids'], HEALTH_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'Seller'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const known = new Map(queue.value.items.map((row) => [row.sellerId as string, row]));
    if (listed.value.some((id) => !known.has(id))) return err({ code: 'file.not-found' });
    rows = listed.value.map((id) => known.get(id) as SellerHealthQueueItem);
  } else {
    const query = parseListQuery(record, SPEC);
    if (!query.ok) return query;
    const selector = parseSelector(record);
    if (!selector.ok) return selector;
    if (queue.value.truncated) return err({ code: 'batch.too-large', max: UNHEALTHY_QUEUE_MAX });
    rows = select(queue.value.items, selector.value, {
      key: query.value.sort,
      direction: query.value.direction,
    });
  }

  const picked = columns.value;
  const groups: (readonly (readonly ExportCell[])[])[] = [
    [[...BASE_HEADERS, ...picked.map((column) => HEADERS[column])]],
    rows.map((row) => [
      row.storeName ?? '',
      row.slug ?? '',
      row.score,
      row.lowestMetric,
      ...picked.map((column) => cellOf(column, row)),
    ]),
  ];
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'sellers-needing-attention',
      sheetName: 'Needs a look',
      day: deps.clock.now().toString().slice(0, 10),
      groups: asyncGroups(groups),
      sheetWriter: deps.sheetWriter,
    }),
  );
}
