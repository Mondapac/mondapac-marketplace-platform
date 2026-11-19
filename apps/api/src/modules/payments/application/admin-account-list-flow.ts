import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
  type ExportCell,
  type ExportFile,
  type ExportInputFailure,
  type ExportTooLarge,
  type SheetWriter,
} from '../../../platform/list-export';
import {
  listPage,
  MAX_PAGED_ROWS,
  pageWindow,
  parseListQuery,
  type ListPagingMode,
} from '../../../platform/list-query';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { ACCOUNT_STATUSES, isPayoutReady, type AccountStatus } from '../domain/connected-account';
import {
  ACCOUNT_EXPORT_COLUMNS,
  ACCOUNT_REQUIREMENT_FILTERS,
  ACCOUNT_SORT_KEYS,
  ACCOUNT_WAITING_FILTERS,
  type AccountExportColumn,
  type AccountListFilter,
  type AccountRowAction,
  type AccountSort,
  type AccountSortKey,
} from '../domain/connected-account-list';
import { isCoolingOff } from '../domain/payout-change';
import type { ConnectedAccountRow } from './admin-account-flow';
import type {
  AccountListCursor,
  ConnectedAccountListReader,
} from './ports/connected-account-list.reader';
import type { ConnectedAccountRecord } from './ports/connected-account-store';
import type { SellerNames } from './ports/seller-names';

// The admin Seller accounts list (super list phase 4, list 22) and its export: the Market's
// connected accounts with status tabs and counts, search by store name or seller id, filters,
// sort, page numbers or Previous/Next, and a CSV or XLSX file. Read only: no Stripe id, bank
// detail or requirement content is ever answered or written to the file.

export interface AdminAccountListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly list: ConnectedAccountListReader;
  readonly sellerNames: SellerNames;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const ACCOUNT_LIST_DEFAULT_PAGE_SIZE = 25;
export const ACCOUNT_LIST_MAX_PAGE_SIZE = 100;
/** Chosen rows one export may name. */
export const ACCOUNT_EXPORT_MAX_IDS = 200;
const EXPORT_CHUNK = 500;
/** The store search's bounds in code points: the sellers facade's own (2 to 80). */
const SEARCH_MIN = 2;
const SEARCH_MAX = 80;

export interface AccountListRow extends ConnectedAccountRow {
  readonly actions: readonly AccountRowAction[];
}

export interface AccountListPage {
  readonly items: readonly AccountListRow[];
  /** Per status tab (`all` included) for the same search and filters; null in Previous/Next. */
  readonly counts: Readonly<Record<'all' | AccountStatus, number>> | null;
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /**
   * The older card's "Show more": set when the rows are newest created first and more follow.
   * Pass it back as `cursor`.
   */
  readonly nextCursor: string | null;
  /**
   * The store search matched more stores than sellers answers: the rows, the total and the counts
   * cover only the stores it answered. Narrow the search.
   */
  readonly searchCapped: boolean;
}

type Fields = { path: string; code: string }[];

export type AccountListFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'payments.search-unavailable' };

export type AccountExportFailure =
  | AccountListFailure
  | ExportInputFailure
  | ExportTooLarge
  | { readonly code: 'payments.connected-account.not-found' };

type Input = Readonly<Record<string, unknown>>;

const SELECTOR_KEYS = ['status', 'ready', 'requirements', 'waiting', 'q', 'from', 'to'];
const LIST_KEYS = new Set([
  ...SELECTOR_KEYS,
  'sort',
  'direction',
  'page',
  'pageSize',
  'paging',
  'cursor',
]);
const EXPORT_KEYS = new Set([...SELECTOR_KEYS, 'sort', 'direction', 'format', 'columns', 'ids']);

const isAdmin = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

const absent = (value: unknown) => value === undefined || value === null || value === '';

/** A page cursor is `<created-at ms>.<seller id>`: opaque to callers, checked on the way in. */
export const encodeCursor = (createdAt: Temporal.Instant, sellerId: string): string =>
  `${createdAt.epochMilliseconds}.${sellerId}`;

function decodeCursor(value: unknown): AccountListCursor | null {
  if (typeof value !== 'string') return null;
  const match = /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value);
  const id = match === null ? null : parseId<'Seller'>(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return {
    createdAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    sellerId: id.value,
  };
}

function oneOf<T extends string>(
  fields: Fields,
  path: string,
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (absent(value)) return null;
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) fields.push({ path, code: 'value' });
  return found ?? null;
}

function instant(fields: Fields, path: string, value: unknown): Temporal.Instant | null {
  if (absent(value)) return null;
  try {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return Temporal.Instant.from(value);
    }
  } catch {
    // falls through to the refusal below
  }
  fields.push({ path, code: 'format' });
  return null;
}

interface Selector {
  readonly filter: AccountListFilter;
  /** A store-name search still to resolve through sellers. */
  readonly search: string | null;
}

function selectorOf(fields: Fields, input: Input, now: Temporal.Instant): Selector {
  const status = oneOf(fields, 'status', input.status, ACCOUNT_STATUSES);
  const readyWord = oneOf(fields, 'ready', input.ready, ['yes', 'no'] as const);
  const requirements = oneOf(
    fields,
    'requirements',
    input.requirements,
    ACCOUNT_REQUIREMENT_FILTERS,
  );
  const waiting = oneOf(fields, 'waiting', input.waiting, ACCOUNT_WAITING_FILTERS);
  let sellerId: string | null = null;
  let search: string | null = null;
  if (!absent(input.q)) {
    if (typeof input.q !== 'string') fields.push({ path: 'q', code: 'type' });
    else {
      const term = input.q.trim();
      // A seller id finds that seller exactly; anything else searches the store names.
      const parsed = parseId<'Seller'>(term.toLowerCase());
      if (parsed.ok) sellerId = parsed.value;
      else {
        const length = [...term].length;
        if (length < SEARCH_MIN || length > SEARCH_MAX) fields.push({ path: 'q', code: 'length' });
        else search = term;
      }
    }
  }
  const from = instant(fields, 'from', input.from);
  const to = instant(fields, 'to', input.to);
  if (from !== null && to !== null && Temporal.Instant.compare(from, to) >= 0) {
    fields.push({ path: 'to', code: 'range' });
  }
  return {
    filter: {
      status,
      ready: readyWord === null ? null : readyWord === 'yes',
      requirements,
      waiting,
      sellerId,
      sellerIds: null,
      from,
      to,
      now,
    },
    search,
  };
}

function unknownKey(input: Input, known: ReadonlySet<string>): string | null {
  return Object.keys(input).find((key) => !known.has(key)) ?? null;
}

/**
 * Resolves the store search through sellers before the read unit; fails closed (a failed lookup
 * refuses the request instead of listing every account). The term is never logged.
 */
async function resolveSearch(
  deps: AdminAccountListDependencies,
  context: CallContext,
  selector: Selector,
): Promise<Result<{ filter: AccountListFilter; capped: boolean }, AccountListFailure>> {
  if (selector.search === null) return ok({ filter: selector.filter, capped: false });
  try {
    const found = await deps.sellerNames.storesMatching(context, selector.search);
    return ok({ filter: { ...selector.filter, sellerIds: found.sellerIds }, capped: found.capped });
  } catch {
    return err({ code: 'payments.search-unavailable' });
  }
}

/** The row the admin sees: never the Stripe id, the hash or a requirement's content. */
export function accountRowOf(
  record: ConnectedAccountRecord,
  now: Temporal.Instant,
  sellerName: string | null,
): ConnectedAccountRow {
  return {
    sellerId: record.sellerId,
    sellerName,
    status: record.status,
    ready: isPayoutReady(record.status, record.coolingOffUntil, now),
    requirementsDue: record.requirementsDue,
    requirementsPastDue: record.requirementsPastDue,
    coolingOffUntil: isCoolingOff(record.coolingOffUntil, now) ? record.coolingOffUntil : null,
    payoutsPaused: isCoolingOff(record.payoutsPausedUntil, now),
    lastReadAt: record.lastReadAt,
    createdAt: record.createdAt,
  };
}

/** The store names of the rows; a name that cannot be read degrades to null (the panel shows the id). */
async function namesOf(
  deps: AdminAccountListDependencies,
  context: CallContext,
  records: readonly ConnectedAccountRecord[],
): Promise<ReadonlyMap<string, string | null>> {
  const ids = [...new Set(records.map((row) => row.sellerId as Id<'Seller'>))];
  if (ids.length === 0) return new Map();
  try {
    const names = await deps.sellerNames.storeNames(context, ids);
    return names === 'unavailable' ? new Map() : names;
  } catch {
    return new Map();
  }
}

const NEWEST: AccountSort = { key: 'created', direction: 'desc' };

/**
 * The Market's connected accounts for the admin list. With `cursor` it answers the older card's
 * "Show more" (newest created first, 25 rows); otherwise the shared list query (`paging`,
 * `page`, `pageSize`, `sort`, `direction`).
 */
export async function listAccountPage(
  deps: AdminAccountListDependencies,
  context: CallContext,
  input: Input,
): Promise<Result<AccountListPage, AccountListFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const record = input ?? {};
  const fields: Fields = [];
  const key = unknownKey(record, LIST_KEYS);
  if (key !== null) fields.push({ path: key, code: 'unknown' });
  const now = deps.clock.now();
  const selector = selectorOf(fields, record, now);
  let after: AccountListCursor | null = null;
  if (!absent(record.cursor)) {
    after = decodeCursor(record.cursor);
    if (after === null) fields.push({ path: 'cursor', code: 'format' });
    for (const path of ['page', 'pageSize', 'paging', 'sort', 'direction']) {
      if (!absent(record[path])) fields.push({ path, code: 'with-cursor' });
    }
  }
  const query = parseListQuery<AccountSortKey>(record, {
    sorts: ACCOUNT_SORT_KEYS,
    defaultSort: 'created',
    defaultPageSize: ACCOUNT_LIST_DEFAULT_PAGE_SIZE,
    maxPageSize: ACCOUNT_LIST_MAX_PAGE_SIZE,
    maxPage: MAX_PAGED_ROWS,
  });
  const withCursor = !absent(record.cursor);
  // With a cursor the paging keys are refused as `with-cursor` above, not checked again.
  if (!query.ok) {
    if (!withCursor) fields.push(...query.error.fields);
  } else if (!withCursor && query.value.page * query.value.pageSize > MAX_PAGED_ROWS) {
    fields.push({ path: 'page', code: 'too-deep' });
  }
  if (fields.length > 0 || !query.ok) {
    return err({
      code: 'validation.failed',
      fields: fields.length > 0 ? fields : query.ok ? [] : query.error.fields,
    });
  }
  const searched = await resolveSearch(deps, context, selector);
  if (!searched.ok) return searched;
  const { filter } = searched.value;
  const listQuery = query.value;
  const sort: AccountSort = { key: listQuery.sort, direction: listQuery.direction };
  const read = await deps.unitOfWork.run<
    {
      readonly rows: readonly ConnectedAccountRecord[];
      readonly total: number | null;
      readonly byStatus: Readonly<Record<AccountStatus, number>> | null;
      readonly hasNext: boolean;
    },
    AccountListFailure
  >(
    context.market,
    async () => {
      const market = context.market;
      if (after !== null) {
        const rows = await deps.list.page(
          market,
          filter,
          NEWEST,
          0,
          ACCOUNT_LIST_DEFAULT_PAGE_SIZE + 1,
          after,
        );
        return ok({
          rows: rows.slice(0, ACCOUNT_LIST_DEFAULT_PAGE_SIZE),
          total: null,
          byStatus: null,
          hasNext: rows.length > ACCOUNT_LIST_DEFAULT_PAGE_SIZE,
        });
      }
      const window = pageWindow(listQuery);
      const rows = await deps.list.page(market, filter, sort, window.offset, window.limit);
      if (listQuery.paging === 'prev-next') {
        const page = listPage(rows, listQuery, null);
        return ok({ rows: page.items, total: null, byStatus: null, hasNext: page.hasNext });
      }
      const total = await deps.list.count(market, filter);
      const byStatus = await deps.list.countByStatus(market, filter);
      const page = listPage(rows, listQuery, total);
      return ok({ rows: page.items, total, byStatus, hasNext: page.hasNext });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { rows, total, byStatus, hasNext } = read.value;
  const names = await namesOf(deps, context, rows);
  const last = rows[rows.length - 1];
  const newestFirst = after !== null || (sort.key === 'created' && sort.direction === 'desc');
  let counts: AccountListPage['counts'] = null;
  if (byStatus !== null) {
    const all = ACCOUNT_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);
    counts = { all, ...byStatus };
  }
  return ok({
    items: rows.map((row) => ({
      ...accountRowOf(row, now, names.get(row.sellerId) ?? null),
      actions: ['open'] as const,
    })),
    counts,
    total,
    page: after !== null ? 1 : listQuery.page,
    pageSize: after !== null ? ACCOUNT_LIST_DEFAULT_PAGE_SIZE : listQuery.pageSize,
    paging: after !== null ? 'prev-next' : listQuery.paging,
    hasNext,
    nextCursor:
      newestFirst && hasNext && last !== undefined
        ? encodeCursor(last.createdAt, last.sellerId)
        : null,
    searchCapped: searched.value.capped,
  });
}

/** The panel's words (apps/admin messages, `payments.accounts`). */
const STATUS_LABELS: Readonly<Record<AccountStatus, string>> = Object.freeze({
  'not-started': 'Not started',
  pending: 'Pending',
  enabled: 'Enabled',
  restricted: 'Restricted',
  rejected: 'Rejected',
});
const BASE_HEADERS = ['Seller', 'Status', 'Ready', 'Details due', 'Past due', 'Created'] as const;
const HEADERS: Readonly<Record<AccountExportColumn, string>> = {
  'cooling-off': 'Waiting until (UTC)',
  paused: 'Payouts paused',
  'last-read': 'Last checked (UTC)',
  'seller-id': 'Seller ID',
};
const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

function cellOf(column: AccountExportColumn, row: ConnectedAccountRow): ExportCell {
  switch (column) {
    case 'cooling-off':
      return row.coolingOffUntil?.toString() ?? '';
    case 'paused':
      return yesNo(row.payoutsPaused);
    case 'last-read':
      return row.lastReadAt?.toString() ?? '';
    case 'seller-id':
      return row.sellerId;
  }
}

/**
 * The Market's connected accounts as a CSV or XLSX file: the chosen `ids` (seller ids, at most 200;
 * one that has no account in this Market refuses the whole request) or what the selector keys
 * match, at most 10,000, in the list's sort. With `ids` the selector keys are ignored.
 */
export async function exportAccounts(
  deps: AdminAccountListDependencies,
  context: CallContext,
  input: Input,
): Promise<Result<ExportFile, AccountExportFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const record = input ?? {};
  const key = unknownKey(record, EXPORT_KEYS);
  if (key !== null) {
    return err({ code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] });
  }
  const format = parseExportFormat(record.format);
  if (!format.ok) return format;
  const columns = parseExportColumns(record.columns, ACCOUNT_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;
  const now = deps.clock.now();
  let ids: readonly string[];
  if (!absent(record.ids)) {
    if (typeof record.ids !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'ids', code: 'type' }] });
    }
    const listed = parseExportIds(record.ids, ACCOUNT_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'Seller'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly ConnectedAccountRecord[], AccountListFailure>(
      market,
      async () => ok(await deps.list.byIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const known = new Set(found.value.map((row) => row.sellerId));
    if (wanted.some((id) => !known.has(id))) {
      return err({ code: 'payments.connected-account.not-found' });
    }
    ids = wanted;
  } else {
    const fields: Fields = [];
    const selector = selectorOf(fields, record, now);
    const query = parseListQuery<AccountSortKey>(
      { sort: record.sort, direction: record.direction },
      {
        sorts: ACCOUNT_SORT_KEYS,
        defaultSort: 'created',
        defaultPageSize: ACCOUNT_LIST_DEFAULT_PAGE_SIZE,
        maxPageSize: ACCOUNT_LIST_MAX_PAGE_SIZE,
        maxPage: MAX_PAGED_ROWS,
      },
    );
    if (!query.ok) fields.push(...query.error.fields);
    if (fields.length > 0 || !query.ok) return err({ code: 'validation.failed', fields });
    const searched = await resolveSearch(deps, context, selector);
    if (!searched.ok) return searched;
    // A capped store search would export a partial set while saying it is the whole match.
    if (searched.value.capped) {
      return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-broad' }] });
    }
    const filter = searched.value.filter;
    const sort: AccountSort = { key: query.value.sort, direction: query.value.direction };
    const picked = await deps.unitOfWork.run<
      { readonly found: readonly string[]; readonly total: number },
      AccountListFailure
    >(
      market,
      async () => {
        const found = await deps.list.ids(market, filter, sort, LIST_EXPORT_MAX_ROWS + 1);
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
  const chosen = columns.value;
  async function* rows(): AsyncGenerator<readonly (readonly ExportCell[])[]> {
    yield [[...BASE_HEADERS, ...chosen.map((column) => HEADERS[column])]];
    for (let start = 0; start < ids.length; start += EXPORT_CHUNK) {
      const chunk = ids.slice(start, start + EXPORT_CHUNK);
      const read = await deps.unitOfWork.run<readonly ConnectedAccountRecord[], AccountListFailure>(
        market,
        async () => ok(await deps.list.byIds(market, chunk)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('payments.connected-accounts-export: the read failed');
      const names = await namesOf(deps, context, read.value);
      const bySeller = new Map(read.value.map((row) => [row.sellerId, row]));
      yield chunk.flatMap((id) => {
        const found = bySeller.get(id);
        if (found === undefined) return [];
        const row = accountRowOf(found, now, names.get(id) ?? null);
        return [
          [
            row.sellerName ?? `Seller ${row.sellerId}`,
            STATUS_LABELS[row.status],
            yesNo(row.ready),
            row.requirementsDue,
            yesNo(row.requirementsPastDue),
            row.createdAt.toString(),
            ...chosen.map((column) => cellOf(column, row)),
          ],
        ];
      });
    }
  }
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'seller-accounts',
      sheetName: 'Seller accounts',
      day: now.toString().slice(0, 10),
      groups: rows(),
      sheetWriter: deps.sheetWriter,
    }),
  );
}
