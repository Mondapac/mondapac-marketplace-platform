import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import {
  buildExportFile,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
  type ExportCell,
  type ExportFile,
  type SheetWriter,
} from '../../../../platform/list-export';
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
  type ListQueryFailure,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import {
  compareIssuerRequests,
  EMPTY_ISSUER_REQUEST_FILTER,
  ISSUER_REQUEST_EXPORT_COLUMNS,
  ISSUER_REQUEST_LIST_VIEWS,
  ISSUER_REQUEST_SORT_KEYS,
  issuerRequestMatches,
  type IssuerRequestExportColumn,
  type IssuerRequestFilter,
  type IssuerRequestRowAction,
  type IssuerRequestSort,
} from '../../domain/issuer-request-list';
import type { IssuerRequestQueueEntry } from '../ports/issuer-request.repository';
import { reviewerOf } from '../review/review.shared';
import type { IssuerRequestDependencies } from './issuer-request.shared';

// The admin list of open issuer requests (super list phase 3, list 36) and its export. A read:
// nothing here answers a request. The row actions only name what the caller may do; the answer's
// own use case checks `certification.issuer.edit`, the version and the state again when it runs.
// There is no bulk answer: each answer names an issuer or a reason. The typed name never leaves
// the audited single read.

export const ISSUER_ROW_KEYS = [CERTIFICATION_ISSUER_EDIT.key] as const;

export const ISSUER_ROW_RULES: readonly RowActionRule<IssuerRequestQueueEntry>[] = [
  { id: 'open', permission: null },
  { id: 'answer', permission: CERTIFICATION_ISSUER_EDIT.key },
];

export interface IssuerRequestListDependencies extends Pick<
  IssuerRequestDependencies,
  'unitOfWork' | 'requests' | 'sellers'
> {
  readonly probes: Readonly<Record<(typeof ISSUER_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const ISSUER_LIST_DEFAULT_PAGE_SIZE = 25;
export const ISSUER_LIST_MAX_PAGE_SIZE = 100;
export const ISSUER_EXPORT_MAX_IDS = 200;
/** The most open requests one read takes (tens in a Market; design 7.5 caps 3 a seller a day). */
export const ISSUER_LIST_READ_CAP = 500;

const SELECTOR_KEYS = ['view', 'type', 'q', 'sellerId', 'from', 'to'] as const;
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

export type IssuerRequestListInput = Readonly<Record<string, unknown>>;

export type IssuerRequestListFailure =
  | ListQueryFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'issuer-request.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface IssuerRequestListRow {
  readonly issuerRequestId: string;
  /** The version an answer must name. */
  readonly version: number;
  readonly typeCode: string;
  readonly sellerId: string;
  /** Null for a seller with no approved revision. */
  readonly storeName: string | null;
  readonly documentCount: number;
  readonly createdAt: string;
  readonly actions: readonly IssuerRequestRowAction[];
}

export interface IssuerRequestListPage extends ListPage<IssuerRequestListRow> {
  /** Every open request of the Market (up to the read cap), whatever the filter. */
  readonly counts: { readonly all: number };
  /** True when the Market has more open requests than the read cap: the newest are not read. */
  readonly truncated: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

function parseSelector(
  record: IssuerRequestListInput,
): Result<IssuerRequestFilter, ListQueryFailure> {
  if (!absent(record['view']) && !ISSUER_REQUEST_LIST_VIEWS.some((v) => v === record['view'])) {
    return listQueryInvalid('view', 'value');
  }
  let typeCode: string | null = null;
  if (!absent(record['type'])) {
    if (typeof record['type'] !== 'string' || !TYPE_CODE.test(record['type'])) {
      return listQueryInvalid('type', 'format');
    }
    typeCode = record['type'];
  }
  let requestId: string | null = null;
  if (!absent(record['q'])) {
    const text = typeof record['q'] === 'string' ? record['q'].trim().toLowerCase() : '';
    if (!UUID.test(text)) return listQueryInvalid('q', 'format');
    requestId = text;
  }
  let sellerId: Id<'Seller'> | null = null;
  if (!absent(record['sellerId'])) {
    const parsed =
      typeof record['sellerId'] === 'string' ? parseId<'Seller'>(record['sellerId']) : null;
    if (parsed === null || !parsed.ok) return listQueryInvalid('sellerId', 'format');
    sellerId = parsed.value;
  }
  const range = parseInstantRange(record, '');
  if (!range.ok) return range;
  return ok({
    ...EMPTY_ISSUER_REQUEST_FILTER,
    typeCode,
    requestId,
    sellerId,
    from: range.value.from,
    to: range.value.to,
  });
}

const unknownKey = (record: IssuerRequestListInput, allowed: ReadonlySet<string>): string | null =>
  Object.keys(record).find((key) => !allowed.has(key)) ?? null;

const SPEC = {
  sorts: ISSUER_REQUEST_SORT_KEYS,
  defaultSort: 'submitted',
  // Oldest request first: the queue's old order stays the default.
  defaultDirection: () => 'asc' as const,
  defaultPageSize: ISSUER_LIST_DEFAULT_PAGE_SIZE,
  maxPageSize: ISSUER_LIST_MAX_PAGE_SIZE,
  maxPage: MAX_PAGED_ROWS,
} as const;

/** Reads one row past the cap, so `truncated` is true only when requests were really left out. */
async function readOpen(
  deps: IssuerRequestListDependencies,
  context: CallContext,
): Promise<{ readonly open: readonly IssuerRequestQueueEntry[]; readonly truncated: boolean }> {
  const read = await deps.unitOfWork.run<readonly IssuerRequestQueueEntry[], never>(
    context.market,
    async () => ok(await deps.requests.openQueue(context.market, ISSUER_LIST_READ_CAP + 1)),
    { readOnly: true },
  );
  if (!read.ok) throw new Error('certification.issuer-request-list: the read failed');
  const truncated = read.value.length > ISSUER_LIST_READ_CAP;
  return { open: truncated ? read.value.slice(0, ISSUER_LIST_READ_CAP) : read.value, truncated };
}

function select(
  open: readonly IssuerRequestQueueEntry[],
  filter: IssuerRequestFilter,
  sort: IssuerRequestSort,
): IssuerRequestQueueEntry[] {
  return open
    .filter((entry) => issuerRequestMatches(entry, filter))
    .sort((a, b) => compareIssuerRequests(a, b, sort));
}

/** The names are advisory: a failed lookup leaves them null and the list still answers. */
async function namesOf(
  deps: IssuerRequestListDependencies,
  context: CallContext,
  entries: readonly IssuerRequestQueueEntry[],
): Promise<ReadonlyMap<string, string>> {
  if (entries.length === 0) return new Map();
  try {
    return await deps.sellers.storeNames(context, [...new Set(entries.map((e) => e.sellerId))]);
  } catch {
    return new Map();
  }
}

/**
 * The open issuer requests of the Market: one page with its total (page numbers) or without
 * (Previous/Next), the count, the public store names (advisory) and each row's actions.
 */
export async function listIssuerRequests(
  deps: IssuerRequestListDependencies,
  context: CallContext,
  input: IssuerRequestListInput,
): Promise<Result<IssuerRequestListPage, IssuerRequestListFailure>> {
  if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
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
  const sort: IssuerRequestSort = { key: query.value.sort, direction: query.value.direction };

  const { open, truncated } = await readOpen(deps, context);
  const matching = select(open, selector.value, sort);
  const { offset, limit } = pageWindow(query.value);
  const window = matching.slice(offset, offset + limit);
  const page = listPage(window, query.value, matching.length);
  const [names, granted] = await Promise.all([
    namesOf(deps, context, page.items),
    page.items.length === 0 ? Promise.resolve(new Set<string>()) : heldKeys(context, deps.probes),
  ]);
  return ok({
    ...page,
    items: page.items.map((entry) => ({
      issuerRequestId: entry.id,
      version: entry.version,
      typeCode: entry.typeCode,
      sellerId: entry.sellerId,
      storeName: names.get(entry.sellerId) ?? null,
      documentCount: entry.documentCount,
      createdAt: entry.createdAt.toString(),
      actions: rowActions(entry, ISSUER_ROW_RULES, granted) as IssuerRequestRowAction[],
    })),
    counts: { all: open.length },
    truncated,
  });
}

// --- the export --------------------------------------------------------------------------------

const BASE_HEADERS = ['Type', 'Store', 'Submitted (UTC)'] as const;
const HEADERS: Readonly<Record<IssuerRequestExportColumn, string>> = {
  'request-id': 'Request ID',
  'seller-id': 'Seller ID',
  documents: 'Files',
};

function cellOf(column: IssuerRequestExportColumn, entry: IssuerRequestQueueEntry): ExportCell {
  switch (column) {
    case 'request-id':
      return entry.id;
    case 'seller-id':
      return entry.sellerId;
    case 'documents':
      return entry.documentCount;
  }
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
 * The open requests of the list as a CSV or XLSX file: the chosen `ids` (at most 200; an id that
 * is not an open request of the Market refuses the whole request as not found) or what the
 * selector keys match, in the list's sort. The typed issuer name is never in the file.
 */
export async function exportIssuerRequests(
  deps: IssuerRequestListDependencies,
  context: CallContext,
  input: IssuerRequestListInput,
): Promise<Result<ExportFile, IssuerRequestListFailure>> {
  if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
  const record = input ?? {};
  const stray = unknownKey(record, EXPORT_KEYS);
  if (stray !== null) return listQueryInvalid(stray, 'unknown');
  const format = parseExportFormat(record['format']);
  if (!format.ok) return format;
  const columns = parseExportColumns(record['columns'], ISSUER_REQUEST_EXPORT_COLUMNS);
  if (!columns.ok) return columns;

  const { open, truncated } = await readOpen(deps, context);
  let rows: IssuerRequestQueueEntry[];
  if (!absent(record['ids'])) {
    if (typeof record['ids'] !== 'string') return listQueryInvalid('ids', 'type');
    // The chosen ids are the whole selection: a filter or a sort beside them is a mistake.
    const clash = [...SELECTOR_KEYS, 'sort', 'direction'].find((key) => !absent(record[key]));
    if (clash !== undefined) return listQueryInvalid(clash, 'with-ids');
    const listed = parseExportIds(record['ids'], ISSUER_EXPORT_MAX_IDS, (part) => {
      const text = part.trim().toLowerCase();
      return UUID.test(text) ? text : null;
    });
    if (!listed.ok) return listed;
    const known = new Map(open.map((entry) => [entry.id as string, entry]));
    if (listed.value.some((id) => !known.has(id))) return err({ code: 'issuer-request.not-found' });
    rows = listed.value.map((id) => known.get(id) as IssuerRequestQueueEntry);
  } else {
    const query = parseListQuery(record, SPEC);
    if (!query.ok) return query;
    const selector = parseSelector(record);
    if (!selector.ok) return selector;
    rows = select(open, selector.value, {
      key: query.value.sort,
      direction: query.value.direction,
    });
    // The read stops at the cap, so a file from the selector would silently miss the newest
    // requests: refuse it, and let the admin pick the rows by id.
    if (truncated) {
      return err({ code: 'batch.too-large', max: ISSUER_LIST_READ_CAP });
    }
  }

  const names = await namesOf(deps, context, rows);
  const picked = columns.value;
  const groups: (readonly (readonly ExportCell[])[])[] = [
    [[...BASE_HEADERS, ...picked.map((column) => HEADERS[column])]],
    rows.map((entry) => [
      entry.typeCode,
      names.get(entry.sellerId) ?? `Seller ${entry.sellerId}`,
      entry.createdAt.toString(),
      ...picked.map((column) => cellOf(column, entry)),
    ]),
  ];
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'issuer-requests',
      sheetName: 'Issuer requests',
      day: deps.clock.now().toString().slice(0, 10),
      groups: asyncGroups(groups),
      sheetWriter: deps.sheetWriter,
    }),
  );
}
