import { Logger } from '@nestjs/common';
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
import {
  COMMISSION_PAYOUTS_PAYOUT_APPROVE,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE,
} from '../contracts/permissions';
import {
  HOLDABLE_STATES,
  PAYOUT_EXPORT_COLUMNS,
  PAYOUT_LIST_VIEWS,
  PAYOUT_SORT_KEYS,
  PAYOUT_VIEW_STATES,
  viewCounts,
  type PayoutActionSubject,
  type PayoutExportColumn,
  type PayoutListCursor,
  type PayoutListFilter,
  type PayoutListView,
  type PayoutRowAction,
  type PayoutSort,
  type PayoutStateCounts,
} from '../domain/admin-payout-list';
import { PAYOUT_STATES, type Payout, type PayoutState } from '../domain/payout';
import type { ApprovalMode } from '../domain/payout-terms';
import type { PayoutFailure, PayoutRowView } from './payout-admin-flow';
import type { AdminPayoutListReader } from './ports/admin-payout-list.reader';
import type { SellerNames } from './ports/seller-names';
import type { StoreNameSearch } from './ports/store-name-search';

// The admin Payouts list (super list phase 4, list 21) and its export. A read: nothing here moves
// money or changes a payout. The row actions only name what the caller may open; each action's
// own use case checks its key, the payout's state and the step-up again when it runs.

const logger = new Logger('AdminPayoutList');

export interface AdminPayoutListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly payouts: AdminPayoutListReader;
  readonly sellerNames: SellerNames;
  readonly storeSearch: StoreNameSearch;
  /** One probe per key of {@link PAYOUT_ROW_RULES}: the gate says which ones the caller holds. */
  readonly probes: Readonly<Record<(typeof PAYOUT_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

/** The keys the row actions need; the list asks the gate for each one once per page. */
export const PAYOUT_ROW_KEYS = [
  COMMISSION_PAYOUTS_PAYOUT_APPROVE.key,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE.key,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE.key,
] as const;

/**
 * The row Actions menu of a payout (plan: Open, Hold payout…, Release…; plus Approve… on a payout
 * that waits). Each key is the key the action's own use case checks. Approve, placing and
 * releasing a hold are money actions of level 3: the panel asks to type the payout's reference and
 * for the step-up, and the use case checks the key and the state again.
 */
export const PAYOUT_ROW_RULES: readonly RowActionRule<PayoutActionSubject>[] = [
  { id: 'open', permission: null },
  {
    id: 'approve',
    permission: COMMISSION_PAYOUTS_PAYOUT_APPROVE.key,
    when: (row) => row.state === 'awaiting-approval',
  },
  {
    id: 'place-hold',
    permission: COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE.key,
    when: (row) => HOLDABLE_STATES.includes(row.state) && row.activeHoldId === null,
  },
  {
    id: 'release-hold',
    permission: COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE.key,
    // The hold is over the whole seller; it is offered where it still stops this payout.
    when: (row) => HOLDABLE_STATES.includes(row.state) && row.activeHoldId !== null,
  },
];

export const PAYOUT_LIST_DEFAULT_PAGE_SIZE = 25;
/** The Previous/Next page of the older panel: 50 rows unless `limit` says otherwise. */
export const PAYOUT_LIST_DEFAULT_LIMIT = 50;
export const PAYOUT_LIST_MAX_PAGE_SIZE = 100;
export const PAYOUT_SEARCH_MIN = 2;
export const PAYOUT_SEARCH_MAX = 80;
/** Chosen rows one export may name: the same cap as the selection of a page. */
export const PAYOUT_EXPORT_MAX_IDS = 200;
/** Payouts read per chunk while an export streams. */
const EXPORT_CHUNK = 500;

/** The query of the list; every field is optional and checked here. */
export interface PayoutListInput {
  /** A view (tab): all (default), awaiting-approval, sending, paid, failed or not-sent. */
  readonly view?: unknown;
  /** One state, in the API's spelling or the upper-case one; it narrows the view. */
  readonly status?: unknown;
  /** A payout id, exact. */
  readonly q?: unknown;
  /** A part of the store name, 2 to 80 characters. */
  readonly search?: unknown;
  readonly sellerId?: unknown;
  readonly approvalMode?: unknown;
  /** ISO instants on the creation time: at or after `from`, before `to`. */
  readonly from?: unknown;
  readonly to?: unknown;
  /** The transfer in minor units, a string of digits; both ends included. */
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

export interface AdminPayoutRow extends PayoutRowView {
  /** The seller's active admin hold over the whole seller (the Release action), or null. */
  readonly activeHoldId: Id<'PayoutHold'> | null;
  readonly actions: readonly PayoutRowAction[];
}

export interface AdminPayoutListPage {
  readonly payouts: readonly AdminPayoutRow[];
  /** The count of each view for the Market, whatever the filter. */
  readonly counts: Readonly<Record<PayoutListView, number>>;
  /** Page numbers: the total, the page and its size. Previous/Next: total and page are null. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
  /** The store search matched more sellers than sellers answers: narrow it. */
  readonly searchCapped: boolean;
}

const STATE_SPELLINGS = (value: unknown): PayoutState | null | undefined => {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const normal = value.toLowerCase().replaceAll('_', '-');
  return (PAYOUT_STATES as readonly string[]).includes(normal)
    ? (normal as PayoutState)
    : undefined;
};
const APPROVAL_MODES: readonly ApprovalMode[] = ['AUTO', 'MANUAL'];
const AMOUNT = /^[0-9]{1,15}$/;

/** A cursor is `<created-at ms>.<payout id>`, the cursor the older panel already holds. */
export const encodePayoutListCursor = (row: PayoutListCursor): string =>
  `${row.createdAt.epochMilliseconds}.${row.payoutId}`;

function decodeCursor(value: unknown): PayoutListCursor | null {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<'Payout'>(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return {
    createdAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    payoutId: id.value,
  };
}

type Paging =
  | { readonly kind: 'pages'; readonly page: number; readonly pageSize: number }
  | { readonly kind: 'prev-next'; readonly after: PayoutListCursor | null; readonly limit: number };

export interface PayoutSelector {
  readonly filter: PayoutListFilter;
  readonly search: string | null;
}

export type Fields = { path: string; code: string }[];

/**
 * The selector keys (view, search, filters) shared by the list, the export and the saved filters.
 */
export function parsePayoutSelector(input: PayoutListInput, fields: Fields): PayoutSelector {
  const oneOf = <T extends string>(path: string, value: unknown, list: readonly T[]): T | null => {
    if (value === undefined || value === '') return null;
    if (list.includes(value as T)) return value as T;
    fields.push({ path, code: 'value' });
    return null;
  };
  const view = oneOf('view', input.view, PAYOUT_LIST_VIEWS) ?? 'all';
  const state = STATE_SPELLINGS(input.status);
  if (state === undefined) fields.push({ path: 'status', code: 'value' });
  const approvalMode = oneOf('approvalMode', input.approvalMode, APPROVAL_MODES);
  const id = <K extends string>(path: string, value: unknown): Id<K> | null => {
    if (value === undefined || value === '') return null;
    const parsed = typeof value === 'string' ? parseId<K>(value.trim().toLowerCase()) : null;
    if (parsed !== null && parsed.ok) return parsed.value;
    fields.push({ path, code: 'format' });
    return null;
  };
  // Matched, never echoed or logged.
  const payoutId = id<'Payout'>('q', input.q);
  const sellerId = id<'Seller'>('sellerId', input.sellerId);
  let search: string | null = null;
  if (input.search !== undefined && input.search !== '') {
    const text = typeof input.search === 'string' ? input.search.trim() : null;
    const length = text === null ? 0 : [...text].length;
    if (text !== null && length >= PAYOUT_SEARCH_MIN && length <= PAYOUT_SEARCH_MAX) search = text;
    else fields.push({ path: 'search', code: 'length' });
  }
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
    filter: {
      states: view === 'all' ? null : PAYOUT_VIEW_STATES[view],
      state: state ?? null,
      payoutId,
      sellerId,
      approvalMode,
      from,
      to,
      minAmount,
      maxAmount,
      sellerIds: null,
    },
    search,
  };
}

const whole = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;

function parse(
  input: PayoutListInput,
): Result<PayoutSelector & { readonly sort: PayoutSort; readonly paging: Paging }, PayoutFailure> {
  const fields: Fields = [];
  const selector = parsePayoutSelector(input, fields);
  const prevNext = input.cursor !== undefined || input.limit !== undefined;
  let paging: Paging;
  let sort: PayoutSort = { key: 'created', direction: 'desc' };
  if (prevNext) {
    for (const path of ['page', 'pageSize', 'sort', 'direction'] as const) {
      if (input[path] !== undefined) fields.push({ path, code: 'with-cursor' });
    }
    let limit = PAYOUT_LIST_DEFAULT_LIMIT;
    if (input.limit !== undefined) {
      const given = whole(input.limit, 1, PAYOUT_LIST_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'limit', code: 'range' });
      else limit = given;
    }
    let after: PayoutListCursor | null = null;
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
    let pageSize = PAYOUT_LIST_DEFAULT_PAGE_SIZE;
    if (input.pageSize !== undefined) {
      const given = whole(input.pageSize, 1, PAYOUT_LIST_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'pageSize', code: 'range' });
      else pageSize = given;
    }
    let key: PayoutSort['key'] = 'created';
    if (input.sort !== undefined) {
      if ((PAYOUT_SORT_KEYS as readonly unknown[]).includes(input.sort)) {
        key = input.sort as PayoutSort['key'];
      } else fields.push({ path: 'sort', code: 'value' });
    }
    let direction: PayoutSort['direction'] = 'desc';
    if (input.direction !== undefined) {
      if (input.direction === 'asc' || input.direction === 'desc') direction = input.direction;
      else fields.push({ path: 'direction', code: 'value' });
    }
    sort = { key, direction };
    if (fields.length === 0 && page * pageSize > MAX_PAGED_ROWS) {
      fields.push({ path: 'page', code: 'too-deep' });
    }
    paging = { kind: 'pages', page, pageSize };
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({ ...selector, sort, paging });
}

const isAdmin = (context: CallContext) =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

/**
 * Resolves the store search through sellers before the read unit; fails closed (a failed lookup
 * refuses the request instead of listing every payout). The term is never logged.
 */
async function resolveSearch(
  deps: AdminPayoutListDependencies,
  context: CallContext,
  selector: PayoutSelector,
): Promise<Result<{ filter: PayoutListFilter; capped: boolean }, PayoutFailure>> {
  if (selector.search === null) return ok({ filter: selector.filter, capped: false });
  try {
    const found = await deps.storeSearch.storesMatching(context, selector.search);
    return ok({ filter: { ...selector.filter, sellerIds: found.sellerIds }, capped: found.capped });
  } catch {
    logger.warn({
      msg: 'commission-payouts.admin-payout-search.lookup-failed',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'commission-payouts.search-unavailable' });
  }
}

const moneyOf = (amountMinor: bigint, currency: string) => ({ amountMinor, currency });

const rowOf = (payout: Payout, storeName: string | null): PayoutRowView => ({
  payoutId: payout.id,
  sellerId: payout.sellerId,
  storeName,
  state: payout.state,
  gross: moneyOf(payout.gross, payout.currency),
  netted: moneyOf(payout.netted, payout.currency),
  transfer: moneyOf(payout.transfer, payout.currency),
  approvalMode: payout.approvalMode,
  approvalReason: payout.approvalReason,
  slotAt: payout.slotAt,
  outcomeCode: payout.outcomeCode,
  createdAt: payout.createdAt,
  stateChangedAt: payout.stateChangedAt,
});

async function storeNamesOf(
  deps: AdminPayoutListDependencies,
  context: CallContext,
  payouts: readonly Payout[],
): Promise<ReadonlyMap<Id<'Seller'>, string | null>> {
  const ids = [...new Set(payouts.map((payout) => payout.sellerId))];
  if (ids.length === 0) return new Map();
  try {
    const names = await deps.sellerNames.storeNames(context, ids);
    // A name that cannot be read degrades to the id; the payout is shown all the same.
    return names === 'unavailable' ? new Map() : names;
  } catch {
    return new Map();
  }
}

/**
 * The total of a filter that is only a view (or a view and one state), read from the state
 * counts; null when the filter narrows further and must be counted.
 */
export function viewTotal(filter: PayoutListFilter, counts: PayoutStateCounts): number | null {
  const { states, state, ...rest } = filter;
  if (Object.values(rest).some((value) => value !== null)) return null;
  const shown = (states ?? PAYOUT_STATES).filter((s) => state === null || s === state);
  return shown.reduce((total, s) => total + counts[s], 0);
}

/**
 * The Market's payouts for the admin Payouts list: one page with its total (page numbers) or its
 * next cursor (Previous/Next), the view counts, the store names (advisory) and each row's actions.
 */
export async function listAdminPayouts(
  deps: AdminPayoutListDependencies,
  context: CallContext,
  input: PayoutListInput,
): Promise<Result<AdminPayoutListPage, PayoutFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const parsed = parse(input ?? {});
  if (!parsed.ok) return parsed;
  const { sort, paging } = parsed.value;
  const searched = await resolveSearch(deps, context, parsed.value);
  if (!searched.ok) return searched;
  const { filter } = searched.value;

  const read = await deps.unitOfWork.run<
    {
      readonly payouts: readonly Payout[];
      readonly total: number | null;
      readonly nextCursor: string | null;
      readonly counts: PayoutStateCounts;
      readonly holds: ReadonlyMap<Id<'Seller'>, Id<'PayoutHold'>>;
    },
    PayoutFailure
  >(
    context.market,
    async () => {
      const counts = await deps.payouts.countByState(context.market);
      let payouts: readonly Payout[];
      let total: number | null = null;
      let nextCursor: string | null = null;
      if (paging.kind === 'prev-next') {
        // One row more than asked tells whether a next page exists.
        const rows = await deps.payouts.page(
          context.market,
          filter,
          sort,
          0,
          paging.limit + 1,
          paging.after,
        );
        payouts = rows.slice(0, paging.limit);
        const last = payouts[payouts.length - 1];
        if (rows.length > paging.limit && last !== undefined) {
          nextCursor = encodePayoutListCursor({ createdAt: last.createdAt, payoutId: last.id });
        }
      } else {
        payouts = await deps.payouts.page(
          context.market,
          filter,
          sort,
          (paging.page - 1) * paging.pageSize,
          paging.pageSize,
        );
        total = viewTotal(filter, counts) ?? (await deps.payouts.count(context.market, filter));
      }
      const sellers = [...new Set(payouts.map((payout) => payout.sellerId))];
      const holds =
        sellers.length === 0
          ? new Map<Id<'Seller'>, Id<'PayoutHold'>>()
          : await deps.payouts.activeAdminHolds(context.market, sellers);
      return ok({ payouts, total, nextCursor, counts, holds });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { payouts, holds } = read.value;
  const [names, granted] = await Promise.all([
    storeNamesOf(deps, context, payouts),
    payouts.length === 0 ? Promise.resolve(new Set<string>()) : heldKeys(context, deps.probes),
  ]);
  return ok({
    payouts: payouts.map((payout) => {
      const activeHoldId = holds.get(payout.sellerId) ?? null;
      return {
        ...rowOf(payout, names.get(payout.sellerId) ?? null),
        // The hold's id is for the Release action only: no release key, no id.
        activeHoldId: granted.has(COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE.key) ? activeHoldId : null,
        actions: rowActions(
          { state: payout.state, activeHoldId },
          PAYOUT_ROW_RULES,
          granted,
        ) as PayoutRowAction[],
      };
    }),
    counts: viewCounts(read.value.counts),
    total: read.value.total,
    page: paging.kind === 'pages' ? paging.page : null,
    pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
    nextCursor: read.value.nextCursor,
    searchCapped: searched.value.capped,
  });
}

// --- the export --------------------------------------------------------------------------------

export interface PayoutExportInput extends PayoutListInput {
  readonly format?: unknown;
  /** Comma-separated optional columns, in the order the page shows them. */
  readonly columns?: unknown;
  /** Comma-separated payout ids (chosen rows); without it the selector keys pick the payouts. */
  readonly ids?: unknown;
}

export type PayoutExportFailure =
  | PayoutFailure
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

const EXPORT_KEYS = new Set([
  'format',
  'columns',
  'ids',
  'view',
  'status',
  'q',
  'search',
  'sellerId',
  'approvalMode',
  'from',
  'to',
  'minAmount',
  'maxAmount',
  'sort',
  'direction',
]);

const HEADERS: Readonly<Record<PayoutExportColumn | 'base', readonly string[]>> = {
  base: ['Payout ID', 'Store', 'Status', 'Transfer', 'Currency', 'Created'],
  gross: ['Gross'],
  netted: ['Netted'],
  'approval-mode': ['Approval'],
  'approval-reason': ['Approval reason'],
  slot: ['Schedule slot'],
  'state-changed': ['Status changed'],
  outcome: ['Outcome'],
  'seller-id': ['Seller ID'],
};

const STATE_LABELS: Readonly<Record<PayoutState, string>> = Object.freeze({
  pending: 'Planned',
  'awaiting-approval': 'Awaiting approval',
  approved: 'Approved',
  instructing: 'Sending',
  instructed: 'Sent',
  paid: 'Paid',
  failed: 'Failed',
  'not-sent': 'Not sent',
  voided: 'Cancelled',
  'settled-by-netting': 'Settled against debt',
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

function cellOf(column: PayoutExportColumn, payout: Payout): ExportCell {
  switch (column) {
    case 'gross':
      return decimalOf(payout.gross, payout.currency);
    case 'netted':
      return decimalOf(payout.netted, payout.currency);
    case 'approval-mode':
      return payout.approvalMode;
    case 'approval-reason':
      return payout.approvalReason;
    case 'slot':
      return payout.slotAt.toString();
    case 'state-changed':
      return payout.stateChangedAt.toString();
    case 'outcome':
      return payout.outcomeCode;
    case 'seller-id':
      return payout.sellerId;
  }
}

/**
 * The payouts of the list as a CSV or XLSX file: the chosen `ids` (at most 200; an id that is not
 * a payout of the Market refuses the whole request as not found) or what the selector keys match,
 * at most 10,000 (more is `batch.too-large` with the total), in the list's sort. With `ids` the
 * selector keys are ignored: the panel sends its current filter along with a chosen set. The ids are fixed
 * first in one read; the rows then stream in chunks, each with its own read and its store names.
 */
export async function exportAdminPayouts(
  deps: AdminPayoutListDependencies,
  context: CallContext,
  input: PayoutExportInput,
): Promise<Result<ExportFile, PayoutExportFailure>> {
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
  const columns = parseExportColumns(input.columns, PAYOUT_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;

  let ids: readonly Id<'Payout'>[];
  if (input.ids !== undefined && input.ids !== '') {
    if (typeof input.ids !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'ids', code: 'type' }] });
    }
    const listed = parseExportIds(input.ids, PAYOUT_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'Payout'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly Payout[], PayoutFailure>(
      market,
      async () => ok(await deps.payouts.byIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const known = new Set(found.value.map((payout) => payout.id));
    if (wanted.some((id) => !known.has(id))) {
      return err({ code: 'commission-payouts.payout-not-found' });
    }
    ids = wanted;
  } else {
    const fields: Fields = [];
    const selector = parsePayoutSelector(input, fields);
    let sort: PayoutSort = { key: 'created', direction: 'desc' };
    if (input.sort !== undefined) {
      if ((PAYOUT_SORT_KEYS as readonly unknown[]).includes(input.sort)) {
        sort = { ...sort, key: input.sort as PayoutSort['key'] };
      } else fields.push({ path: 'sort', code: 'value' });
    }
    if (input.direction !== undefined) {
      if (input.direction === 'asc' || input.direction === 'desc') {
        sort = { ...sort, direction: input.direction };
      } else fields.push({ path: 'direction', code: 'value' });
    }
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const searched = await resolveSearch(deps, context, selector);
    if (!searched.ok) return searched;
    // A search that matched more stores than it can carry would export only part of the list.
    if (searched.value.capped) {
      return err({ code: 'validation.failed', fields: [{ path: 'search', code: 'too-broad' }] });
    }
    const filter = searched.value.filter;
    const picked = await deps.unitOfWork.run<
      { readonly found: readonly Id<'Payout'>[]; readonly total: number },
      PayoutFailure
    >(
      market,
      async () => {
        const found = await deps.payouts.idsPage(market, filter, sort, LIST_EXPORT_MAX_ROWS + 1);
        if (found.length <= LIST_EXPORT_MAX_ROWS) return ok({ found, total: found.length });
        return ok({ found, total: await deps.payouts.count(market, filter) });
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
      baseName: 'payouts',
      sheetName: 'Payouts',
      day: deps.clock.now().toString().slice(0, 10),
      groups: exportRows(deps, context, ids, columns.value),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

async function* exportRows(
  deps: AdminPayoutListDependencies,
  context: CallContext,
  ids: readonly Id<'Payout'>[],
  columns: readonly PayoutExportColumn[],
): AsyncGenerator<readonly (readonly ExportCell[])[]> {
  yield [[...HEADERS.base, ...columns.flatMap((column) => HEADERS[column])]];
  for (let start = 0; start < ids.length; start += EXPORT_CHUNK) {
    const chunk = ids.slice(start, start + EXPORT_CHUNK);
    const read = await deps.unitOfWork.run<readonly Payout[], PayoutFailure>(
      context.market,
      async () => ok(await deps.payouts.byIds(context.market, chunk)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('commission-payouts.admin-payouts-export: the read failed');
    // In the order the ids were fixed (the list's sort), whatever order the read answers.
    const byId = new Map(read.value.map((payout) => [payout.id, payout]));
    const payouts = chunk.flatMap((id) => {
      const payout = byId.get(id);
      return payout === undefined ? [] : [payout];
    });
    const names = await storeNamesOf(deps, context, payouts);
    yield payouts.map((payout) => [
      payout.id,
      names.get(payout.sellerId) ?? `Seller ${payout.sellerId}`,
      STATE_LABELS[payout.state],
      decimalOf(payout.transfer, payout.currency),
      payout.currency,
      payout.createdAt.toString(),
      ...columns.map((column) => cellOf(column, payout)),
    ]);
  }
}
