import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
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
  MAX_PAGED_ROWS,
  rowActions,
  type PermissionProbe,
  type RowActionRule,
} from '../../../platform/list-query';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { BUYER_ACCOUNT_DELETE } from '../contracts/permissions';
import type {
  AccountDeletionRequester,
  AccountDeletionRequestStatus,
} from '../domain/account-deletion-request';
import {
  DELETION_CANCEL_REASONS,
  DELETION_EXPORT_COLUMNS,
  DELETION_LIST_VIEWS,
  DELETION_REQUESTERS,
  DELETION_SORT_KEYS,
  deletionViewCounts,
  type DeletionCancelReason,
  type DeletionExportColumn,
  type DeletionListCursor,
  type DeletionListFilter,
  type DeletionListRow,
  type DeletionListView,
  type DeletionRowAction,
  type DeletionSort,
  type DeletionStatusCounts,
} from '../domain/admin-deletion-list';
import { isActingAs } from './account-deletion-settings-flow';
import type { AdminDeletionListReader } from './ports/admin-deletion-list.reader';

// The admin Account deletion requests list (super list phase 4, list 25) and its export. A read:
// nothing here cancels or carries out a request. The row actions only name what the caller may
// open; cancelling runs through its own use case, which checks the key, the step-up and the status
// again. No name, email, ticket reference or admin reason is read or written here.

type FieldError = { path: string; code: string };

export interface AdminDeletionListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly list: AdminDeletionListReader;
  /** One probe per key of {@link DELETION_ROW_RULES}: the gate says which ones the caller holds. */
  readonly probes: Readonly<Record<(typeof DELETION_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const DELETION_ROW_KEYS = [BUYER_ACCOUNT_DELETE.key] as const;

/** The row Actions menu: Cancel… on a request still waiting, for a holder of the delete key. */
export const DELETION_ROW_RULES: readonly RowActionRule<{
  readonly status: AccountDeletionRequestStatus;
}>[] = [
  {
    id: 'cancel',
    permission: BUYER_ACCOUNT_DELETE.key,
    when: (row) => row.status === 'pending',
  },
];

export type AdminDeletionListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] };

export const DELETION_LIST_DEFAULT_PAGE_SIZE = 25;
/** The Previous/Next page of the older list: 20 rows unless `limit` says otherwise. */
export const DELETION_LIST_DEFAULT_LIMIT = 20;
export const DELETION_LIST_MAX_PAGE_SIZE = 100;
/** Chosen rows one export may name: the same cap as the selection of a page. */
export const DELETION_EXPORT_MAX_IDS = 200;
/** Requests read per chunk while an export streams. */
const EXPORT_CHUNK = 500;

/** The query of the list; every field is optional and checked here. */
export interface DeletionListInput {
  /** A view (tab): pending (default, as the older list), executing, cancelled, completed or all. */
  readonly view?: unknown;
  /** The older list's name of the view; only `pending`, and never with `view`. */
  readonly status?: unknown;
  readonly requestedBy?: unknown;
  readonly cancelReason?: unknown;
  /** A request id or a buyer's account id, exact. */
  readonly q?: unknown;
  /** ISO instants on the request time: at or after `from`, before `to`. */
  readonly from?: unknown;
  readonly to?: unknown;
  /** ISO instant: scheduled before it. */
  readonly scheduledBefore?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  /** Page numbers (List paging `pages`): page from 1, page x pageSize at most 10,000. */
  readonly page?: unknown;
  readonly pageSize?: unknown;
  /**
   * Previous/Next (List paging `prev-next`): asked for by `cursor` or `limit`, earliest scheduled
   * first only, so no `page`, `pageSize`, `sort` or `direction` with it.
   */
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

export interface AdminDeletionRow extends DeletionListRow {
  readonly actions: readonly DeletionRowAction[];
}

export interface AdminDeletionListPage {
  readonly entries: readonly AdminDeletionRow[];
  /** The count of each view for the Market, whatever the filter. */
  readonly counts: Readonly<Record<DeletionListView, number>>;
  /** Page numbers: the total, the page and its size. Previous/Next: total and page are null. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
}

/** A cursor is `<scheduled-for ms>.<request id>`, the cursor the older list already holds. */
export const encodeDeletionListCursor = (row: DeletionListCursor): string =>
  `${row.scheduledFor.epochMilliseconds}.${row.id}`;

function decodeCursor(value: unknown): DeletionListCursor | null {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<'AccountDeletionRequest'>(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return { scheduledFor: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

type Paging =
  | { readonly kind: 'pages'; readonly page: number; readonly pageSize: number }
  | {
      readonly kind: 'prev-next';
      readonly after: DeletionListCursor | null;
      readonly limit: number;
    };

/** A platform admin on a real admin session: not a seller, a buyer or an acting-as session. */
function isAdmin(context: CallContext): boolean {
  const actor = context.actor;
  return (
    actor.kind === 'authenticated' &&
    actor.population === 'admin' &&
    actor.sellerId === null &&
    !isActingAs(context)
  );
}

/** The selector keys (view and filters) shared by the list and the export. */
function parseSelector(input: DeletionListInput, fields: FieldError[]): DeletionListFilter {
  const oneOf = <T extends string>(path: string, value: unknown, list: readonly T[]): T | null => {
    if (value === undefined || value === '') return null;
    if (list.includes(value as T)) return value as T;
    fields.push({ path, code: 'value' });
    return null;
  };
  // The older list sends `status=pending` (its only value) and no `view`.
  let view: DeletionListView = 'pending';
  if (input.status !== undefined) {
    if (input.view !== undefined) fields.push({ path: 'status', code: 'with-view' });
    else if (input.status !== 'pending') fields.push({ path: 'status', code: 'value' });
  }
  view = oneOf('view', input.view, DELETION_LIST_VIEWS) ?? view;
  const requestedBy = oneOf<AccountDeletionRequester>(
    'requestedBy',
    input.requestedBy,
    DELETION_REQUESTERS,
  );
  const cancelReason = oneOf<DeletionCancelReason>(
    'cancelReason',
    input.cancelReason,
    DELETION_CANCEL_REASONS,
  );
  let requestOrAccountId: string | null = null;
  if (input.q !== undefined && input.q !== '') {
    // Matched, never echoed or logged.
    const parsed = typeof input.q === 'string' ? parseId(input.q.trim().toLowerCase()) : null;
    if (parsed !== null && parsed.ok) requestOrAccountId = parsed.value;
    else fields.push({ path: 'q', code: 'format' });
  }
  const instant = (
    path: 'from' | 'to' | 'scheduledBefore',
    value: unknown,
  ): Temporal.Instant | null => {
    if (value === undefined || value === '') return null;
    try {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return Temporal.Instant.from(value);
      }
    } catch {
      // falls through to the refusal below
    }
    fields.push({ path, code: 'format' });
    return null;
  };
  const from = instant('from', input.from);
  const to = instant('to', input.to);
  if (from !== null && to !== null && Temporal.Instant.compare(from, to) >= 0) {
    fields.push({ path: 'to', code: 'range' });
  }
  const scheduledBefore = instant('scheduledBefore', input.scheduledBefore);
  return {
    status: view === 'all' ? null : view,
    requestedBy,
    cancelReason,
    requestOrAccountId,
    from,
    to,
    scheduledBefore,
  };
}

const whole = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;

const EARLIEST: DeletionSort = { key: 'scheduled', direction: 'asc' };

function parseSort(input: DeletionListInput, fields: FieldError[]): DeletionSort {
  let key: DeletionSort['key'] = EARLIEST.key;
  if (input.sort !== undefined) {
    if ((DELETION_SORT_KEYS as readonly unknown[]).includes(input.sort)) {
      key = input.sort as DeletionSort['key'];
    } else fields.push({ path: 'sort', code: 'value' });
  }
  let direction: DeletionSort['direction'] = key === 'scheduled' ? 'asc' : 'desc';
  if (input.direction !== undefined) {
    if (input.direction === 'asc' || input.direction === 'desc') direction = input.direction;
    else fields.push({ path: 'direction', code: 'value' });
  }
  return { key, direction };
}

function parse(
  input: DeletionListInput,
): Result<
  { readonly filter: DeletionListFilter; readonly sort: DeletionSort; readonly paging: Paging },
  AdminDeletionListFailure
> {
  const fields: FieldError[] = [];
  const filter = parseSelector(input, fields);
  const prevNext = input.cursor !== undefined || input.limit !== undefined;
  let paging: Paging;
  let sort = EARLIEST;
  if (prevNext) {
    for (const path of ['page', 'pageSize', 'sort', 'direction'] as const) {
      if (input[path] !== undefined) fields.push({ path, code: 'with-cursor' });
    }
    let limit = DELETION_LIST_DEFAULT_LIMIT;
    if (input.limit !== undefined) {
      const given = whole(input.limit, 1, DELETION_LIST_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'limit', code: 'range' });
      else limit = given;
    }
    let after: DeletionListCursor | null = null;
    if (input.cursor !== undefined) {
      after = decodeCursor(input.cursor);
      if (after === null) fields.push({ path: 'cursor', code: 'format' });
    }
    paging = { kind: 'prev-next', after, limit };
  } else {
    let page = 1;
    if (input.page !== undefined) {
      const given = whole(input.page, 1, MAX_PAGED_ROWS);
      if (given === null) fields.push({ path: 'page', code: 'range' });
      else page = given;
    }
    let pageSize = DELETION_LIST_DEFAULT_PAGE_SIZE;
    if (input.pageSize !== undefined) {
      const given = whole(input.pageSize, 1, DELETION_LIST_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'pageSize', code: 'range' });
      else pageSize = given;
    }
    sort = parseSort(input, fields);
    if (fields.length === 0 && page * pageSize > MAX_PAGED_ROWS) {
      fields.push({ path: 'page', code: 'too-deep' });
    }
    paging = { kind: 'pages', page, pageSize };
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({ filter, sort, paging });
}

/**
 * The total of a filter that is only a view, read from the status counts; null when the filter
 * narrows further and must be counted.
 */
export function deletionViewTotal(
  filter: DeletionListFilter,
  counts: DeletionStatusCounts,
): number | null {
  const { status, ...rest } = filter;
  if (Object.values(rest).some((value) => value !== null)) return null;
  return deletionViewCounts(counts)[status ?? 'all'];
}

/**
 * The Market's buyer deletion requests for the Account deletion requests list: one page with its
 * total (page numbers) or its next cursor (Previous/Next), the view counts and each row's actions.
 */
export async function listAdminDeletionRequests(
  deps: AdminDeletionListDependencies,
  context: CallContext,
  input: DeletionListInput,
): Promise<Result<AdminDeletionListPage, AdminDeletionListFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const parsed = parse(input ?? {});
  if (!parsed.ok) return parsed;
  const { filter, sort, paging } = parsed.value;
  const read = await deps.unitOfWork.run<
    {
      readonly rows: readonly DeletionListRow[];
      readonly total: number | null;
      readonly nextCursor: string | null;
      readonly counts: DeletionStatusCounts;
    },
    AdminDeletionListFailure
  >(
    context.market,
    async () => {
      const counts = await deps.list.countByStatus(context.market);
      if (paging.kind === 'prev-next') {
        // One row more than asked tells whether a next page exists.
        const found = await deps.list.page(
          context.market,
          filter,
          EARLIEST,
          0,
          paging.limit + 1,
          paging.after,
        );
        const rows = found.slice(0, paging.limit);
        const last = rows[rows.length - 1];
        const nextCursor =
          found.length > paging.limit && last !== undefined
            ? encodeDeletionListCursor({ scheduledFor: last.scheduledFor, id: last.id })
            : null;
        return ok({ rows, total: null, nextCursor, counts });
      }
      const rows = await deps.list.page(
        context.market,
        filter,
        sort,
        (paging.page - 1) * paging.pageSize,
        paging.pageSize,
      );
      const total =
        deletionViewTotal(filter, counts) ?? (await deps.list.count(context.market, filter));
      return ok({ rows, total, nextCursor: null, counts });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { rows } = read.value;
  const granted = rows.length === 0 ? new Set<string>() : await heldKeys(context, deps.probes);
  return ok({
    entries: rows.map((row) => ({
      ...row,
      actions: rowActions(row, DELETION_ROW_RULES, granted) as DeletionRowAction[],
    })),
    counts: deletionViewCounts(read.value.counts),
    total: read.value.total,
    page: paging.kind === 'pages' ? paging.page : null,
    pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
    nextCursor: read.value.nextCursor,
  });
}

// --- the export --------------------------------------------------------------------------------

export interface DeletionExportInput extends DeletionListInput {
  readonly format?: unknown;
  /** Comma-separated optional columns, in the order the page shows them. */
  readonly columns?: unknown;
  /** Comma-separated request ids (chosen rows); without it the selector keys pick the requests. */
  readonly ids?: unknown;
}

export type DeletionExportFailure =
  | AdminDeletionListFailure
  | { readonly code: 'customers.account-deletion-request-not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

const EXPORT_KEYS = new Set([
  'format',
  'columns',
  'ids',
  'view',
  'status',
  'requestedBy',
  'cancelReason',
  'q',
  'from',
  'to',
  'scheduledBefore',
  'sort',
  'direction',
]);

const HEADERS: Readonly<Record<DeletionExportColumn | 'base', readonly string[]>> = {
  base: [
    'Request ID',
    'Account ID',
    'Status',
    'Requested by',
    'Requested (UTC)',
    'Deletes on (UTC)',
  ],
  cancelled: ['Cancelled (UTC)'],
  'cancel-reason': ['Cancelled by'],
  completed: ['Deleted (UTC)'],
};

/** The panel's words (`account-deletion.requests.status`, `.by`). */
const STATUS_LABELS: Readonly<Record<AccountDeletionRequestStatus, string>> = Object.freeze({
  pending: 'Waiting',
  executing: 'In progress',
  cancelled: 'Cancelled',
  completed: 'Deleted',
});
const REQUESTER_LABELS: Readonly<Record<AccountDeletionRequester, string>> = Object.freeze({
  customer: 'Buyer',
  admin: 'Admin',
});
const CANCEL_LABELS: Readonly<Record<DeletionCancelReason, string>> = Object.freeze({
  customer: 'Buyer',
  'sign-in': 'Buyer signed in',
  admin: 'Admin',
});

const instantText = (value: Temporal.Instant | null) => (value === null ? '' : value.toString());

function cellOf(column: DeletionExportColumn, row: DeletionListRow): ExportCell {
  switch (column) {
    case 'cancelled':
      return instantText(row.cancelledAt);
    case 'cancel-reason':
      return row.cancelReason === null ? '' : CANCEL_LABELS[row.cancelReason];
    case 'completed':
      return instantText(row.completedAt);
  }
}

/**
 * The requests of the list as a CSV or XLSX file: the chosen `ids` (at most 200; an id that is not
 * a request of the Market refuses the whole file as not found) or what the selector keys match, at
 * most 10,000 (more is `batch.too-large` with the total), in the list's sort. The ids are fixed
 * first in one read; the rows then stream in chunks, each with its own read.
 */
export async function exportAdminDeletionRequests(
  deps: AdminDeletionListDependencies,
  context: CallContext,
  input: DeletionExportInput,
): Promise<Result<ExportFile, DeletionExportFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err({ code: 'validation.failed', fields: [{ path: 'query', code: 'type' }] });
  }
  for (const key of Object.keys(input)) {
    if (!EXPORT_KEYS.has(key)) {
      return err({ code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] });
    }
  }
  const format = parseExportFormat(input.format);
  if (!format.ok) return format;
  const columns = parseExportColumns(input.columns, DELETION_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;

  let ids: readonly Id<'AccountDeletionRequest'>[];
  if (input.ids !== undefined && input.ids !== '') {
    if (typeof input.ids !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'ids', code: 'type' }] });
    }
    const listed = parseExportIds(input.ids, DELETION_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'AccountDeletionRequest'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly DeletionListRow[], AdminDeletionListFailure>(
      market,
      async () => ok(await deps.list.byIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const known = new Set<string>(found.value.map((row) => row.id));
    if (wanted.some((id) => !known.has(id))) {
      return err({ code: 'customers.account-deletion-request-not-found' });
    }
    ids = wanted;
  } else {
    const fields: FieldError[] = [];
    const filter = parseSelector(input, fields);
    const sort = parseSort(input, fields);
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const picked = await deps.unitOfWork.run<
      { readonly found: readonly Id<'AccountDeletionRequest'>[]; readonly total: number },
      AdminDeletionListFailure
    >(
      market,
      async () => {
        const found = await deps.list.idsPage(market, filter, sort, LIST_EXPORT_MAX_ROWS + 1);
        if (found.length <= LIST_EXPORT_MAX_ROWS) return ok({ found, total: found.length });
        return ok({ found, total: await deps.list.count(market, filter) });
      },
      { readOnly: true },
    );
    if (!picked.ok) return picked;
    const size = checkExportSize(picked.value.found.length, picked.value.total);
    if (!size.ok) return size;
    ids = picked.value.found;
  }

  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'deletion-requests',
      sheetName: 'Deletion requests',
      day: deps.clock.now().toString().slice(0, 10),
      groups: exportRows(deps, context, ids, columns.value),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

async function* exportRows(
  deps: AdminDeletionListDependencies,
  context: CallContext,
  ids: readonly Id<'AccountDeletionRequest'>[],
  columns: readonly DeletionExportColumn[],
): AsyncGenerator<readonly (readonly ExportCell[])[]> {
  yield [[...HEADERS.base, ...columns.flatMap((column) => HEADERS[column])]];
  for (let start = 0; start < ids.length; start += EXPORT_CHUNK) {
    const chunk = ids.slice(start, start + EXPORT_CHUNK);
    const read = await deps.unitOfWork.run<readonly DeletionListRow[], AdminDeletionListFailure>(
      context.market,
      async () => ok(await deps.list.byIds(context.market, chunk)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('customers.deletion-requests-export: the read failed');
    // In the order the ids were fixed (the list's sort), whatever order the read answers.
    const byId = new Map<string, DeletionListRow>(read.value.map((row) => [row.id, row]));
    const rows = chunk.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
    yield rows.map((row) => [
      row.id,
      row.accountId,
      STATUS_LABELS[row.status],
      REQUESTER_LABELS[row.requestedBy],
      row.requestedAt.toString(),
      row.scheduledFor.toString(),
      ...columns.map((column) => cellOf(column, row)),
    ]);
  }
}
