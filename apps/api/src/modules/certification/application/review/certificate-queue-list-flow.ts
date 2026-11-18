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
import { CERTIFICATION_SELLER_CERTIFICATE_APPROVE } from '../../contracts/permissions';
import {
  CERTIFICATE_QUEUE_EXPORT_COLUMNS,
  CERTIFICATE_QUEUE_SORT_KEYS,
  CERTIFICATE_QUEUE_VIEWS,
  certificateQueueMatches,
  compareCertificateQueue,
  EMPTY_CERTIFICATE_QUEUE_FILTER,
  viewKind,
  type CertificateQueueExportColumn,
  type CertificateQueueFilter,
  type CertificateQueueRowAction,
  type CertificateQueueSort,
  type CertificateQueueView,
} from '../../domain/certificate-queue-list';
import type { SubmissionKind } from '../../domain/seller-certificate';
import type { ReviewQueueEntry } from '../ports/review.repository';
import { reviewerOf, type ReviewDependencies } from './review.shared';

// The admin certificates queue as a super list (phase 3, list 17) and its export. A read: nothing
// here decides a submission. The row actions only name what the caller may do; the decision's own
// use case checks `certification.seller-certificate.approve`, the version and the pending
// submission again when it runs. There is no bulk decision: each one reads its own review page
// (checks, scope, issuer). No number, document or decrypted text is in the list or the file.

export const QUEUE_ROW_KEYS = [CERTIFICATION_SELLER_CERTIFICATE_APPROVE.key] as const;

export const QUEUE_ROW_RULES: readonly RowActionRule<ReviewQueueEntry>[] = [
  { id: 'open', permission: null },
  { id: 'decide', permission: CERTIFICATION_SELLER_CERTIFICATE_APPROVE.key },
];

export interface CertificateQueueListDependencies extends Pick<
  ReviewDependencies,
  'unitOfWork' | 'reviews' | 'sellers'
> {
  readonly probes: Readonly<Record<(typeof QUEUE_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const QUEUE_LIST_DEFAULT_PAGE_SIZE = 25;
export const QUEUE_LIST_MAX_PAGE_SIZE = 100;
export const QUEUE_EXPORT_MAX_IDS = 200;
/** The most waiting submissions one read takes (queue sizes are tens to hundreds; design A5). */
export const QUEUE_LIST_READ_CAP = 500;

const SELECTOR_KEYS = ['view', 'kind', 'type', 'q', 'sellerId', 'from', 'to'] as const;
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

export type CertificateQueueListInput = Readonly<Record<string, unknown>>;

export type CertificateQueueListFailure =
  | ListQueryFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface CertificateQueueListRow {
  readonly certificateId: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly submissionId: string;
  readonly submissionNo: number;
  readonly kind: SubmissionKind;
  readonly typeCode: string;
  readonly sellerId: string;
  /** Null for a seller with no approved revision. */
  readonly storeName: string | null;
  readonly issuerName: string | null;
  readonly submittedAt: string;
  readonly actions: readonly CertificateQueueRowAction[];
}

export type CertificateQueueViewCounts = Readonly<Record<CertificateQueueView, number>>;

export interface CertificateQueueListPage extends ListPage<CertificateQueueListRow> {
  /** The count of each view among the waiting submissions read, whatever the filter. */
  readonly counts: CertificateQueueViewCounts;
  /** True when more are waiting than the read cap: the newest are not read. */
  readonly truncated: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

function parseSelector(
  record: CertificateQueueListInput,
): Result<CertificateQueueFilter, ListQueryFailure> {
  let view: CertificateQueueView = 'all';
  if (!absent(record['view'])) {
    const found = CERTIFICATE_QUEUE_VIEWS.find((candidate) => candidate === record['view']);
    if (found === undefined) return listQueryInvalid('view', 'value');
    view = found;
  }
  let kind = viewKind(view);
  if (!absent(record['kind'])) {
    const found = (['initial', 'resubmission', 'renewal'] as const).find(
      (candidate) => candidate === record['kind'],
    );
    if (found === undefined) return listQueryInvalid('kind', 'value');
    kind = found;
  }
  let typeCode: string | null = null;
  if (!absent(record['type'])) {
    if (typeof record['type'] !== 'string' || !TYPE_CODE.test(record['type'])) {
      return listQueryInvalid('type', 'format');
    }
    typeCode = record['type'];
  }
  let certificateOrSubmissionId: string | null = null;
  if (!absent(record['q'])) {
    const text = typeof record['q'] === 'string' ? record['q'].trim().toLowerCase() : '';
    if (!UUID.test(text)) return listQueryInvalid('q', 'format');
    certificateOrSubmissionId = text;
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
    ...EMPTY_CERTIFICATE_QUEUE_FILTER,
    kind,
    typeCode,
    sellerId,
    certificateOrSubmissionId,
    from: range.value.from,
    to: range.value.to,
  });
}

const unknownKey = (
  record: CertificateQueueListInput,
  allowed: ReadonlySet<string>,
): string | null => Object.keys(record).find((key) => !allowed.has(key)) ?? null;

const SPEC = {
  sorts: CERTIFICATE_QUEUE_SORT_KEYS,
  // The queue's own order: renewals first, then oldest submission first.
  defaultSort: 'queue',
  defaultDirection: () => 'asc' as const,
  defaultPageSize: QUEUE_LIST_DEFAULT_PAGE_SIZE,
  maxPageSize: QUEUE_LIST_MAX_PAGE_SIZE,
  maxPage: MAX_PAGED_ROWS,
} as const;

async function readWaiting(
  deps: CertificateQueueListDependencies,
  context: CallContext,
): Promise<readonly ReviewQueueEntry[]> {
  const read = await deps.unitOfWork.run<readonly ReviewQueueEntry[], never>(
    context.market,
    async () => ok(await deps.reviews.queue(context.market, QUEUE_LIST_READ_CAP)),
    { readOnly: true },
  );
  if (!read.ok) throw new Error('certification.certificate-queue-list: the read failed');
  return read.value;
}

function select(
  waiting: readonly ReviewQueueEntry[],
  filter: CertificateQueueFilter,
  sort: CertificateQueueSort,
): ReviewQueueEntry[] {
  return waiting
    .filter((entry) => certificateQueueMatches(entry, filter))
    .sort((a, b) => compareCertificateQueue(a, b, sort));
}

/** The names are advisory: a failed lookup leaves them null and the list still answers. */
async function namesOf(
  deps: CertificateQueueListDependencies,
  context: CallContext,
  entries: readonly ReviewQueueEntry[],
): Promise<ReadonlyMap<string, string>> {
  if (entries.length === 0) return new Map();
  try {
    return await deps.sellers.storeNames(context, [...new Set(entries.map((e) => e.sellerId))]);
  } catch {
    return new Map();
  }
}

function countsOf(waiting: readonly ReviewQueueEntry[]): CertificateQueueViewCounts {
  const of = (kind: SubmissionKind): number => waiting.filter((e) => e.kind === kind).length;
  return {
    all: waiting.length,
    initial: of('initial'),
    resubmission: of('resubmission'),
    renewal: of('renewal'),
  };
}

/**
 * The waiting submissions of the Market: one page with its total (page numbers) or without
 * (Previous/Next), the view counts, the public store names (advisory) and each row's actions.
 */
export async function listCertificateQueue(
  deps: CertificateQueueListDependencies,
  context: CallContext,
  input: CertificateQueueListInput,
): Promise<Result<CertificateQueueListPage, CertificateQueueListFailure>> {
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
  const sort: CertificateQueueSort = { key: query.value.sort, direction: query.value.direction };

  const waiting = await readWaiting(deps, context);
  const matching = select(waiting, selector.value, sort);
  const { offset, limit } = pageWindow(query.value);
  const page = listPage(matching.slice(offset, offset + limit), query.value, matching.length);
  const [names, granted] = await Promise.all([
    namesOf(deps, context, page.items),
    page.items.length === 0 ? Promise.resolve(new Set<string>()) : heldKeys(context, deps.probes),
  ]);
  return ok({
    ...page,
    items: page.items.map((entry) => ({
      certificateId: entry.certificateId,
      version: entry.version,
      submissionId: entry.submissionId,
      submissionNo: entry.submissionNo,
      kind: entry.kind,
      typeCode: entry.typeCode,
      sellerId: entry.sellerId,
      storeName: names.get(entry.sellerId) ?? null,
      issuerName: entry.issuerName,
      submittedAt: entry.submittedAt.toString(),
      actions: rowActions(entry, QUEUE_ROW_RULES, granted) as CertificateQueueRowAction[],
    })),
    counts: countsOf(waiting),
    truncated: waiting.length >= QUEUE_LIST_READ_CAP,
  });
}

// --- the export --------------------------------------------------------------------------------

const BASE_HEADERS = ['Type', 'Kind', 'Store', 'Issuer', 'Submitted (UTC)'] as const;
const HEADERS: Readonly<Record<CertificateQueueExportColumn, string>> = {
  'certificate-id': 'Certificate ID',
  'submission-id': 'Submission ID',
  'seller-id': 'Seller ID',
  'submission-no': 'Submission no.',
};

function cellOf(column: CertificateQueueExportColumn, entry: ReviewQueueEntry): ExportCell {
  switch (column) {
    case 'certificate-id':
      return entry.certificateId;
    case 'submission-id':
      return entry.submissionId;
    case 'seller-id':
      return entry.sellerId;
    case 'submission-no':
      return entry.submissionNo;
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
 * The waiting submissions of the list as a CSV or XLSX file: the chosen `ids` (certificate ids, at
 * most 200; an id that is not waiting in the Market refuses the whole request as not found, and a
 * filter or sort beside them is refused) or what the selector keys match, in the list's sort. The
 * selector form is refused with `batch.too-large` when the read was cut at the cap, so a file
 * never silently misses the newest submissions.
 */
export async function exportCertificateQueue(
  deps: CertificateQueueListDependencies,
  context: CallContext,
  input: CertificateQueueListInput,
): Promise<Result<ExportFile, CertificateQueueListFailure>> {
  if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
  const record = input ?? {};
  const stray = unknownKey(record, EXPORT_KEYS);
  if (stray !== null) return listQueryInvalid(stray, 'unknown');
  const format = parseExportFormat(record['format']);
  if (!format.ok) return format;
  const columns = parseExportColumns(record['columns'], CERTIFICATE_QUEUE_EXPORT_COLUMNS);
  if (!columns.ok) return columns;

  const waiting = await readWaiting(deps, context);
  let rows: ReviewQueueEntry[];
  if (!absent(record['ids'])) {
    if (typeof record['ids'] !== 'string') return listQueryInvalid('ids', 'type');
    const clash = [...SELECTOR_KEYS, 'sort', 'direction'].find((key) => !absent(record[key]));
    if (clash !== undefined) return listQueryInvalid(clash, 'with-ids');
    const listed = parseExportIds(record['ids'], QUEUE_EXPORT_MAX_IDS, (part) => {
      const text = part.trim().toLowerCase();
      return UUID.test(text) ? text : null;
    });
    if (!listed.ok) return listed;
    const known = new Map(waiting.map((entry) => [entry.certificateId as string, entry]));
    if (listed.value.some((id) => !known.has(id))) return err({ code: 'certificate.not-found' });
    rows = listed.value.map((id) => known.get(id) as ReviewQueueEntry);
  } else {
    const query = parseListQuery(record, SPEC);
    if (!query.ok) return query;
    const selector = parseSelector(record);
    if (!selector.ok) return selector;
    if (waiting.length >= QUEUE_LIST_READ_CAP) {
      return err({ code: 'batch.too-large', max: QUEUE_LIST_READ_CAP });
    }
    rows = select(waiting, selector.value, {
      key: query.value.sort,
      direction: query.value.direction,
    });
  }

  const names = await namesOf(deps, context, rows);
  const picked = columns.value;
  const groups: (readonly (readonly ExportCell[])[])[] = [
    [[...BASE_HEADERS, ...picked.map((column) => HEADERS[column])]],
    rows.map((entry) => [
      entry.typeCode,
      entry.kind,
      names.get(entry.sellerId) ?? `Seller ${entry.sellerId}`,
      entry.issuerName ?? '',
      entry.submittedAt.toString(),
      ...picked.map((column) => cellOf(column, entry)),
    ]),
  ];
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'certificate-queue',
      sheetName: 'Certificate queue',
      day: deps.clock.now().toString().slice(0, 10),
      groups: asyncGroups(groups),
      sheetWriter: deps.sheetWriter,
    }),
  );
}
