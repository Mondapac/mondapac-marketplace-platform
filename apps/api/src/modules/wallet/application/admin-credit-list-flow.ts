import { err, minorUnitExponent, ok, parseId, Temporal } from '@mondapac/shared-kernel';
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
import { WALLET_CREDIT_APPROVE } from '../contracts/permissions';
import {
  ADMIN_CREDIT_REASONS,
  ADMIN_CREDIT_STATUSES,
  APPROVAL_REASONS,
  isPastExpiry,
  type AdminCreditReason,
  type AdminCreditRejectReason,
  type AdminCreditStatus,
  type ApprovalReason,
} from '../domain/admin-credit';
import {
  CREDIT_EXPORT_COLUMNS,
  CREDIT_LIST_VIEWS,
  CREDIT_SORT_KEYS,
  CREDIT_VIEW_STATUSES,
  creditViewCounts,
  type CreditExportColumn,
  type CreditListCursor,
  type CreditListFilter,
  type CreditListView,
  type CreditRowAction,
  type CreditSort,
  type CreditStatusCounts,
} from '../domain/admin-credit-list';
import { isActingAs } from './settings-flow';
import { viewOf, type AdminCreditFailure, type AdminCreditView } from './admin-credit-flow';
import type { AdminCreditRecord } from './ports/admin-credit.repository';
import type { AdminCreditListReader } from './ports/admin-credit-list.reader';

// The admin Credit requests list (super list phase 4, list 24) and its export. A read: nothing
// here grants, approves or rejects credit. The row actions only name what the caller may open;
// approving and rejecting run through their own use cases, which check the key, the step-up, the
// four-eyes rule and the expiry again.

export interface AdminCreditListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly list: AdminCreditListReader;
  /** One probe per key of {@link CREDIT_ROW_RULES}: the gate says which ones the caller holds. */
  readonly probes: Readonly<Record<(typeof CREDIT_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const CREDIT_ROW_KEYS = [WALLET_CREDIT_APPROVE.key] as const;

/** What a row action needs to know of a request and of the caller. */
interface CreditActionSubject {
  readonly status: AdminCreditStatus;
  /** The caller asked for it: the four-eyes rule keeps them from deciding it. */
  readonly own: boolean;
  /** Past its expiry while the sweep has not marked it yet. */
  readonly expired: boolean;
}

const decidable = (row: CreditActionSubject) =>
  row.status === 'pending' && !row.own && !row.expired;

/**
 * The row Actions menu: Open, and Approve… or Reject… on a pending request that another admin
 * asked for and that has not expired. Both are money decisions of level 3: the panel asks for the
 * step-up, and the use case checks the key, the requester and the expiry again.
 */
export const CREDIT_ROW_RULES: readonly RowActionRule<CreditActionSubject>[] = [
  { id: 'open', permission: null },
  { id: 'approve', permission: WALLET_CREDIT_APPROVE.key, when: decidable },
  { id: 'reject', permission: WALLET_CREDIT_APPROVE.key, when: decidable },
];

export const CREDIT_LIST_DEFAULT_PAGE_SIZE = 25;
/** The Previous/Next page of the older queue: 20 rows unless `limit` says otherwise. */
export const CREDIT_LIST_DEFAULT_LIMIT = 20;
export const CREDIT_LIST_MAX_PAGE_SIZE = 100;
/** Chosen rows one export may name: the same cap as the selection of a page. */
export const CREDIT_EXPORT_MAX_IDS = 200;
/** Requests read per chunk while an export streams. */
const EXPORT_CHUNK = 500;

/** The query of the list; every field is optional and checked here. */
export interface CreditListInput {
  /** A view (tab): pending (default, as the older queue), decided, granted or all. */
  readonly view?: unknown;
  /** One status, inside the view. The older queue's `status` (a view) is read as `view`. */
  readonly status?: unknown;
  readonly reason?: unknown;
  readonly approvalReason?: unknown;
  /** A request id or a customer account id, exact. */
  readonly q?: unknown;
  /** The admin who asked, by account id; `me` for the caller. */
  readonly requestedBy?: unknown;
  /** ISO instants on the request time: at or after `from`, before `to`. */
  readonly from?: unknown;
  readonly to?: unknown;
  /** The amount in minor units, a string of digits; both ends included. */
  readonly minAmount?: unknown;
  readonly maxAmount?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  /** Page numbers (List paging `pages`): page from 1, page x pageSize at most 10,000. */
  readonly page?: unknown;
  readonly pageSize?: unknown;
  /**
   * Previous/Next (List paging `prev-next`): asked for by `cursor` or `limit`, newest first only,
   * so no `page`, `pageSize`, `sort` or `direction` with it.
   */
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

export interface AdminCreditRow extends AdminCreditView {
  readonly actions: readonly CreditRowAction[];
}

export interface AdminCreditListPage {
  readonly entries: readonly AdminCreditRow[];
  /** The count of each view for the Market, whatever the filter. */
  readonly counts: Readonly<Record<CreditListView, number>>;
  /** Page numbers: the total, the page and its size. Previous/Next: total and page are null. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
}

const AMOUNT = /^[0-9]{1,15}$/;
const OLD_VIEWS: readonly string[] = ['pending', 'decided', 'granted'];

/**
 * A cursor is `<requested-at ms>.<request id>`, the cursor the older queue already holds. The
 * column keeps microseconds, but every request time is written from the Clock in milliseconds, so
 * the millisecond cursor is exact.
 */
export const encodeCreditListCursor = (row: CreditListCursor): string =>
  `${row.requestedAt.epochMilliseconds}.${row.id}`;

function decodeCursor(value: unknown): CreditListCursor | null {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<'WalletCreditRequest'>(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return { requestedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

type Paging =
  | { readonly kind: 'pages'; readonly page: number; readonly pageSize: number }
  | { readonly kind: 'prev-next'; readonly after: CreditListCursor | null; readonly limit: number };

type Fields = { path: string; code: string }[];

/** The admin who acts; an acting-as session sees no request queue (review S4). */
function signedInAdmin(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAs(context)) {
    return null;
  }
  return actor.accountId;
}

/** The selector keys (view, search, filters) shared by the list and the export. */
function parseSelector(
  input: CreditListInput,
  admin: Id<'Account'>,
  fields: Fields,
): CreditListFilter {
  const oneOf = <T extends string>(path: string, value: unknown, list: readonly T[]): T | null => {
    if (value === undefined || value === '') return null;
    if (list.includes(value as T)) return value as T;
    fields.push({ path, code: 'value' });
    return null;
  };
  // The older queue sends its tab as `status` (pending, decided or granted) and no `view`.
  const legacyView =
    input.view === undefined &&
    typeof input.status === 'string' &&
    OLD_VIEWS.includes(input.status);
  const view =
    oneOf('view', legacyView ? input.status : input.view, CREDIT_LIST_VIEWS) ?? 'pending';
  const status = legacyView
    ? null
    : oneOf<AdminCreditStatus>('status', input.status, ADMIN_CREDIT_STATUSES);
  // One status inside the view: a status the view does not show would only answer an empty list.
  if (status !== null && view !== 'all' && !CREDIT_VIEW_STATUSES[view].includes(status)) {
    fields.push({ path: 'status', code: 'outside-view' });
  }
  const reason = oneOf<AdminCreditReason>('reason', input.reason, ADMIN_CREDIT_REASONS);
  const approvalReason = oneOf<ApprovalReason>(
    'approvalReason',
    input.approvalReason,
    APPROVAL_REASONS,
  );
  const id = <K extends string>(path: string, value: unknown): Id<K> | null => {
    if (value === undefined || value === '') return null;
    const parsed = typeof value === 'string' ? parseId<K>(value.trim().toLowerCase()) : null;
    if (parsed !== null && parsed.ok) return parsed.value;
    fields.push({ path, code: 'format' });
    return null;
  };
  // Matched, never echoed or logged.
  const requestOrCustomerId = id<'WalletCreditRequest'>('q', input.q);
  const requestedBy =
    input.requestedBy === 'me' ? admin : id<'Account'>('requestedBy', input.requestedBy);
  const instant = (path: 'from' | 'to', value: unknown): Temporal.Instant | null => {
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
  const amount = (path: 'minAmount' | 'maxAmount', value: unknown): bigint | null => {
    if (value === undefined || value === '') return null;
    if (typeof value === 'string' && AMOUNT.test(value)) return BigInt(value);
    fields.push({ path, code: 'format' });
    return null;
  };
  const minAmount = amount('minAmount', input.minAmount);
  const maxAmount = amount('maxAmount', input.maxAmount);
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    fields.push({ path: 'maxAmount', code: 'range' });
  }
  return {
    statuses: view === 'all' ? null : CREDIT_VIEW_STATUSES[view],
    status,
    reason,
    approvalReason,
    requestOrCustomerId,
    requestedBy,
    from,
    to,
    minAmount,
    maxAmount,
  };
}

const whole = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;

function parseSort(input: CreditListInput, fields: Fields): CreditSort {
  let key: CreditSort['key'] = 'requested';
  if (input.sort !== undefined) {
    if ((CREDIT_SORT_KEYS as readonly unknown[]).includes(input.sort)) {
      key = input.sort as CreditSort['key'];
    } else fields.push({ path: 'sort', code: 'value' });
  }
  let direction: CreditSort['direction'] = 'desc';
  if (input.direction !== undefined) {
    if (input.direction === 'asc' || input.direction === 'desc') direction = input.direction;
    else fields.push({ path: 'direction', code: 'value' });
  }
  return { key, direction };
}

function parse(
  input: CreditListInput,
  admin: Id<'Account'>,
): Result<
  { readonly filter: CreditListFilter; readonly sort: CreditSort; readonly paging: Paging },
  AdminCreditFailure
> {
  const fields: Fields = [];
  const filter = parseSelector(input, admin, fields);
  const prevNext = input.cursor !== undefined || input.limit !== undefined;
  let paging: Paging;
  let sort: CreditSort = { key: 'requested', direction: 'desc' };
  if (prevNext) {
    for (const path of ['page', 'pageSize', 'sort', 'direction'] as const) {
      if (input[path] !== undefined) fields.push({ path, code: 'with-cursor' });
    }
    let limit = CREDIT_LIST_DEFAULT_LIMIT;
    if (input.limit !== undefined) {
      const given = whole(input.limit, 1, CREDIT_LIST_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'limit', code: 'range' });
      else limit = given;
    }
    let after: CreditListCursor | null = null;
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
    let pageSize = CREDIT_LIST_DEFAULT_PAGE_SIZE;
    if (input.pageSize !== undefined) {
      const given = whole(input.pageSize, 1, CREDIT_LIST_MAX_PAGE_SIZE);
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
 * The total of a filter that is only a view (or a view and one status), read from the status
 * counts; null when the filter narrows further and must be counted.
 */
export function creditViewTotal(
  filter: CreditListFilter,
  counts: CreditStatusCounts,
): number | null {
  const { statuses, status, ...rest } = filter;
  if (Object.values(rest).some((value) => value !== null)) return null;
  const shown = (statuses ?? ADMIN_CREDIT_STATUSES).filter((s) => status === null || s === status);
  return shown.reduce((total, s) => total + counts[s], 0);
}

/**
 * The Market's admin credit requests for the Credit requests list: one page with its total (page
 * numbers) or its next cursor (Previous/Next), the view counts and each row's actions.
 */
export async function listAdminCreditPage(
  deps: AdminCreditListDependencies,
  context: CallContext,
  input: CreditListInput,
): Promise<Result<AdminCreditListPage, AdminCreditFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const parsed = parse(input ?? {}, admin);
  if (!parsed.ok) return parsed;
  const { filter, sort, paging } = parsed.value;
  const read = await deps.unitOfWork.run<
    {
      readonly rows: readonly AdminCreditRecord[];
      readonly total: number | null;
      readonly nextCursor: string | null;
      readonly counts: CreditStatusCounts;
    },
    AdminCreditFailure
  >(
    context.market,
    async () => {
      const counts = await deps.list.countByStatus(context.market);
      if (paging.kind === 'prev-next') {
        // One row more than asked tells whether a next page exists.
        const found = await deps.list.page(
          context.market,
          filter,
          sort,
          0,
          paging.limit + 1,
          paging.after,
        );
        const rows = found.slice(0, paging.limit);
        const last = rows[rows.length - 1];
        const nextCursor =
          found.length > paging.limit && last !== undefined
            ? encodeCreditListCursor({ requestedAt: last.requestedAt, id: last.id })
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
        creditViewTotal(filter, counts) ?? (await deps.list.count(context.market, filter));
      return ok({ rows, total, nextCursor: null, counts });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { rows } = read.value;
  const granted = rows.length === 0 ? new Set<string>() : await heldKeys(context, deps.probes);
  const now = deps.clock.now();
  return ok({
    entries: rows.map((row) => ({
      ...viewOf(row),
      actions: rowActions(
        {
          status: row.status,
          own: row.requestedBy === admin,
          expired: isPastExpiry(row.expiresAt, now),
        },
        CREDIT_ROW_RULES,
        granted,
      ) as CreditRowAction[],
    })),
    counts: creditViewCounts(read.value.counts),
    total: read.value.total,
    page: paging.kind === 'pages' ? paging.page : null,
    pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
    nextCursor: read.value.nextCursor,
  });
}

// --- the export --------------------------------------------------------------------------------

export interface CreditExportInput extends CreditListInput {
  readonly format?: unknown;
  /** Comma-separated optional columns, in the order the page shows them. */
  readonly columns?: unknown;
  /** Comma-separated request ids (chosen rows); without it the selector keys pick the requests. */
  readonly ids?: unknown;
}

export type CreditExportFailure =
  | AdminCreditFailure
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

const EXPORT_KEYS = new Set([
  'format',
  'columns',
  'ids',
  'view',
  'status',
  'reason',
  'approvalReason',
  'q',
  'requestedBy',
  'from',
  'to',
  'minAmount',
  'maxAmount',
  'sort',
  'direction',
]);

const HEADERS: Readonly<Record<CreditExportColumn | 'base', readonly string[]>> = {
  base: [
    'Request ID',
    'Customer ID',
    'Amount',
    'Currency',
    'Reason',
    'Status',
    'Requested by',
    'Requested (UTC)',
  ],
  note: ['Note'],
  'approval-reason': ['Why it needed approval'],
  expires: ['Expires (UTC)'],
  'decided-by': ['Decided by'],
  decided: ['Decided (UTC)'],
  'decision-reason': ['Decision reason'],
  journal: ['Journal reference'],
};

/** The panel's words (`wallet.queue.status`, `wallet.credit.reason`, `wallet.queue.reject-reason`). */
const STATUS_LABELS: Readonly<Record<AdminCreditStatus, string>> = Object.freeze({
  granted: 'Granted',
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
});
const REASON_LABELS: Readonly<Record<AdminCreditReason, string>> = Object.freeze({
  goodwill: 'Goodwill',
  'service-recovery': 'Service recovery',
  promotion: 'Promotion',
  correction: 'Correction',
});
const REJECT_LABELS: Readonly<Record<AdminCreditRejectReason, string>> = Object.freeze({
  'not-justified': 'Not justified',
  'amount-too-high': 'Amount too high',
  duplicate: 'Duplicate',
  'wrong-customer': 'Wrong customer',
  policy: 'Against policy',
});
const APPROVAL_LABELS: Readonly<Record<ApprovalReason, string>> = Object.freeze({
  'issue-cap': 'Over the per-issue limit',
  'daily-cap': 'Over the daily limit',
});

/** Minor units as a decimal amount of the currency (`12345` AUD is `123.45`), exact. */
export function decimalOf(amountMinor: bigint, currency: string): string {
  const digits = minorUnitExponent(currency);
  const negative = amountMinor < 0n;
  const text = (negative ? -amountMinor : amountMinor).toString().padStart(digits + 1, '0');
  const whole = digits === 0 ? text : text.slice(0, -digits);
  const fraction = digits === 0 ? '' : `.${text.slice(-digits)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

const instantText = (value: Temporal.Instant | null) => (value === null ? '' : value.toString());

function cellOf(column: CreditExportColumn, row: AdminCreditRecord): ExportCell {
  switch (column) {
    case 'note':
      return row.note ?? '';
    case 'approval-reason':
      return row.approvalReason === null ? '' : APPROVAL_LABELS[row.approvalReason];
    case 'expires':
      return instantText(row.expiresAt);
    case 'decided-by':
      return row.decidedBy ?? '';
    case 'decided':
      return instantText(row.decidedAt);
    case 'decision-reason':
      return row.decisionReason === null ? '' : REJECT_LABELS[row.decisionReason];
    case 'journal':
      return row.journalId ?? '';
  }
}

/**
 * The requests of the list as a CSV or XLSX file: the chosen `ids` (at most 200; an id that is not
 * a request of the Market refuses the whole file as not found) or what the selector keys match, at
 * most 10,000 (more is `batch.too-large` with the total), in the list's sort. The ids are fixed
 * first in one read; the rows then stream in chunks, each with its own read.
 */
export async function exportAdminCredits(
  deps: AdminCreditListDependencies,
  context: CallContext,
  input: CreditExportInput,
): Promise<Result<ExportFile, CreditExportFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
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
  const columns = parseExportColumns(input.columns, CREDIT_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;

  let ids: readonly Id<'WalletCreditRequest'>[];
  if (input.ids !== undefined && input.ids !== '') {
    if (typeof input.ids !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'ids', code: 'type' }] });
    }
    const listed = parseExportIds(input.ids, CREDIT_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'WalletCreditRequest'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly AdminCreditRecord[], AdminCreditFailure>(
      market,
      async () => ok(await deps.list.byIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const known = new Set<string>(found.value.map((row) => row.id));
    if (wanted.some((id) => !known.has(id))) {
      return err({ code: 'wallet.credit-request-not-found' });
    }
    ids = wanted;
  } else {
    const fields: Fields = [];
    const filter = parseSelector(input, admin, fields);
    const sort = parseSort(input, fields);
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const picked = await deps.unitOfWork.run<
      { readonly found: readonly Id<'WalletCreditRequest'>[]; readonly total: number },
      AdminCreditFailure
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
      baseName: 'credit-requests',
      sheetName: 'Credit requests',
      day: deps.clock.now().toString().slice(0, 10),
      groups: exportRows(deps, context, ids, columns.value),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

async function* exportRows(
  deps: AdminCreditListDependencies,
  context: CallContext,
  ids: readonly Id<'WalletCreditRequest'>[],
  columns: readonly CreditExportColumn[],
): AsyncGenerator<readonly (readonly ExportCell[])[]> {
  yield [[...HEADERS.base, ...columns.flatMap((column) => HEADERS[column])]];
  for (let start = 0; start < ids.length; start += EXPORT_CHUNK) {
    const chunk = ids.slice(start, start + EXPORT_CHUNK);
    const read = await deps.unitOfWork.run<readonly AdminCreditRecord[], AdminCreditFailure>(
      context.market,
      async () => ok(await deps.list.byIds(context.market, chunk)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('wallet.admin-credits-export: the read failed');
    // In the order the ids were fixed (the list's sort), whatever order the read answers.
    const byId = new Map<string, AdminCreditRecord>(read.value.map((row) => [row.id, row]));
    const rows = chunk.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
    yield rows.map((row) => [
      row.id,
      row.customerAccountId,
      decimalOf(row.amountMinor, row.currency),
      row.currency,
      REASON_LABELS[row.reasonCode],
      STATUS_LABELS[row.status],
      row.requestedBy,
      row.requestedAt.toString(),
      ...columns.map((column) => cellOf(column, row)),
    ]);
  }
}
