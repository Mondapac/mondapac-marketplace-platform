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
  type ExportInputFailure,
  type ExportTooLarge,
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
import { COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE } from '../contracts/permissions';
import {
  isCredit,
  LEDGER_KINDS,
  totalsOf,
  type LedgerEntry,
  type LedgerKind,
} from '../domain/ledger';
import { HOLD_REASONS, type HoldOrigin, type HoldReason } from '../domain/payout-hold';
import {
  HOLD_EXPORT_COLUMNS,
  HOLD_LIST_STATUSES,
  HOLD_SORT_KEYS,
  LEDGER_EXPORT_COLUMNS,
  LEDGER_SORT_KEYS,
  type HoldExportColumn,
  type HoldListCursor,
  type HoldListFilter,
  type HoldRowAction,
  type HoldSort,
  type HoldStatusCounts,
  type LedgerExportColumn,
  type LedgerListCursor,
  type LedgerListFilter,
  type LedgerRowAction,
  type LedgerSort,
} from '../domain/seller-page-lists';
import { decimalOf } from './admin-payout-list-flow';
import type { PayoutHoldView } from './hold-flow';
import type { LedgerEntryView, LedgerView } from './ledger-flow';
import type { CommissionPolicy } from './ports/commission-policy';
import type { LedgerRepository } from './ports/ledger.repository';
import type { PayoutHoldRecord } from './ports/payout-hold.repository';
import type { SellerDirectory } from './ports/seller-directory';
import type { SellerPageListReader } from './ports/seller-page-list.reader';
import { sellerIdOf } from './rate-flow';

// The two compact super lists of the admin seller page (super list phase 4, lists 27 and 28): the
// seller's commission ledger and its payout holds, each with search, filters, sort, paging and an
// export. Reads only: releasing a hold keeps its own use case, key and step-up; a row action only
// names what the caller may open or run.

export interface SellerPageListDependencies {
  readonly unitOfWork: UnitOfWork;
  /** The ledger's sums per kind (the balance over every row, whatever the filter). */
  readonly ledger: LedgerRepository;
  readonly lists: SellerPageListReader;
  readonly policy: CommissionPolicy;
  readonly sellers: SellerDirectory;
  /** The probe of the Release key: the gate says whether the caller holds it. */
  readonly probes: Readonly<Record<(typeof HOLD_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const HOLD_ROW_KEYS = [COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE.key] as const;

const LEDGER_ROW_RULES: readonly RowActionRule<LedgerEntry>[] = [
  { id: 'open-order', permission: null },
];

const HOLD_ROW_RULES: readonly RowActionRule<PayoutHoldRecord>[] = [
  { id: 'open-order', permission: null, when: (hold) => hold.sellerOrderId !== null },
  {
    id: 'release',
    permission: COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE.key,
    // The panel's rule (apps/admin `canReleaseHold`): an admin's hold, or a suspended seller's.
    // The system's own holds (a dispute, a refund, a waiting period) end by themselves.
    when: (hold) =>
      hold.releasedAt === null && (hold.origin === 'admin' || hold.reason === 'seller-suspended'),
  },
];

/** Previous/Next of the older ledger card: 50 rows unless `limit` says otherwise. */
export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_DEFAULT_PAGE_SIZE = 25;
/** The older holds card shows up to 100 holds in one answer; page numbers keep that size. */
export const HOLD_DEFAULT_PAGE_SIZE = 100;
export const SELLER_PAGE_MAX_PAGE_SIZE = 100;
/** Chosen rows one export may name. */
export const SELLER_PAGE_EXPORT_MAX_IDS = 200;
const EXPORT_CHUNK = 500;
const AMOUNT = /^[0-9]{1,15}$/;

export type SellerPageListFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'commission-payouts.rate-unavailable' }
  | { readonly code: 'commission-payouts.seller-not-found' }
  | { readonly code: 'commission-payouts.unavailable' }
  | { readonly code: 'commission-payouts.ledger-entry-not-found' }
  | { readonly code: 'commission-payouts.hold-not-found' };

export type SellerPageExportFailure = SellerPageListFailure | ExportInputFailure | ExportTooLarge;

export type Fields = { path: string; code: string }[];
export type Input = Readonly<Record<string, unknown>>;

const isAdmin = (context: CallContext) =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

export const whole = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;

export function oneOf<T extends string>(
  fields: Fields,
  path: string,
  value: unknown,
  list: readonly T[],
): T | null {
  if (value === undefined || value === '') return null;
  if (list.includes(value as T)) return value as T;
  fields.push({ path, code: 'value' });
  return null;
}

export function idOf<K extends string>(fields: Fields, path: string, value: unknown): Id<K> | null {
  if (value === undefined || value === '') return null;
  const parsed = typeof value === 'string' ? parseId<K>(value.trim().toLowerCase()) : null;
  if (parsed !== null && parsed.ok) return parsed.value;
  fields.push({ path, code: 'format' });
  return null;
}

/** `from` and `to` as ISO instants, `to` after `from`. */
export function instantWindow(
  fields: Fields,
  input: Input,
): { from: Temporal.Instant | null; to: Temporal.Instant | null } {
  const instant = (path: 'from' | 'to'): Temporal.Instant | null => {
    const value = input[path];
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
  const from = instant('from');
  const to = instant('to');
  if (from !== null && to !== null && Temporal.Instant.compare(from, to) >= 0) {
    fields.push({ path: 'to', code: 'range' });
  }
  return { from, to };
}

type Paging<C> =
  | { readonly kind: 'pages'; readonly page: number; readonly pageSize: number }
  | { readonly kind: 'prev-next'; readonly after: C | null; readonly limit: number };

/**
 * Page numbers, or Previous/Next when `cursor` or `limit` is given (newest first only, so no
 * `page`, `pageSize`, `sort` or `direction` with it). Returns the sort for page numbers.
 */
export function pagingOf<K extends string, C>(
  fields: Fields,
  input: Input,
  keys: readonly K[],
  defaults: { readonly sort: K; readonly pageSize: number; readonly limit?: number },
  decode: (value: unknown) => C | null,
): { paging: Paging<C>; sort: { key: K; direction: 'asc' | 'desc' } } {
  const sort = { key: defaults.sort, direction: 'desc' as 'asc' | 'desc' };
  if (input.cursor !== undefined || input.limit !== undefined) {
    for (const path of ['page', 'pageSize', 'sort', 'direction']) {
      if (input[path] !== undefined) fields.push({ path, code: 'with-cursor' });
    }
    let limit = defaults.limit ?? LEDGER_DEFAULT_LIMIT;
    if (input.limit !== undefined) {
      const given = whole(input.limit, 1, SELLER_PAGE_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'limit', code: 'range' });
      else limit = given;
    }
    let after: C | null = null;
    if (input.cursor !== undefined) {
      after = decode(input.cursor);
      if (after === null) fields.push({ path: 'cursor', code: 'format' });
    }
    return { paging: { kind: 'prev-next', after, limit }, sort };
  }
  let page = 1;
  if (input.page !== undefined) {
    const given = whole(input.page, 1, MAX_PAGED_ROWS);
    if (given === null) fields.push({ path: 'page', code: 'range' });
    else page = given;
  }
  let pageSize = defaults.pageSize;
  if (input.pageSize !== undefined) {
    const given = whole(input.pageSize, 1, SELLER_PAGE_MAX_PAGE_SIZE);
    if (given === null) fields.push({ path: 'pageSize', code: 'range' });
    else pageSize = given;
  }
  sortOf(fields, input, keys, sort);
  if (fields.length === 0 && page * pageSize > MAX_PAGED_ROWS) {
    fields.push({ path: 'page', code: 'too-deep' });
  }
  return { paging: { kind: 'pages', page, pageSize }, sort };
}

export function sortOf<K extends string>(
  fields: Fields,
  input: Input,
  keys: readonly K[],
  sort: { key: K; direction: 'asc' | 'desc' },
): void {
  if (input.sort !== undefined) {
    if (keys.includes(input.sort as K)) sort.key = input.sort as K;
    else fields.push({ path: 'sort', code: 'value' });
  }
  if (input.direction !== undefined) {
    if (input.direction === 'asc' || input.direction === 'desc') sort.direction = input.direction;
    else fields.push({ path: 'direction', code: 'value' });
  }
}

/** A cursor is `<ms>.<uuid>`: opaque to callers, checked on the way in. */
export function decodeCursor<K extends string>(
  value: unknown,
): { at: Temporal.Instant; id: Id<K> } | null {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<K>(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return { at: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

export const cursorOf = (at: Temporal.Instant, id: string): string =>
  `${at.epochMilliseconds}.${id}`;

function sellerOf(context: CallContext, input: Input): Result<Id<'Seller'>, SellerPageListFailure> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
  }
  return ok(sellerId);
}

/** Refuses a key the list does not know (a typo must not widen an export). */
export function unknownKey(input: Input, known: ReadonlySet<string>): string | null {
  return Object.keys(input).find((key) => !known.has(key)) ?? null;
}

async function exportCaps<T>(
  read: () => Promise<{ readonly found: readonly T[]; readonly total: number }>,
  deps: SellerPageListDependencies,
  context: CallContext,
): Promise<Result<readonly T[], SellerPageExportFailure>> {
  const picked = await deps.unitOfWork.run<
    { readonly found: readonly T[]; readonly total: number },
    SellerPageListFailure
  >(context.market, async () => ok(await read()), { readOnly: true });
  if (!picked.ok) return picked;
  const size = checkExportSize(picked.value.found.length, picked.value.total);
  if (!size.ok) return size;
  return ok(picked.value.found);
}

// --- the ledger (27) ---------------------------------------------------------------------------

const LEDGER_SELECTOR_KEYS = ['kind', 'side', 'q', 'from', 'to', 'minAmount', 'maxAmount'];
const LEDGER_LIST_KEYS = new Set([
  'sellerId',
  ...LEDGER_SELECTOR_KEYS,
  'sort',
  'direction',
  'page',
  'pageSize',
  'cursor',
  'limit',
]);
const LEDGER_EXPORT_KEYS = new Set([
  'sellerId',
  'format',
  'columns',
  'ids',
  ...LEDGER_SELECTOR_KEYS,
  'sort',
  'direction',
]);

export interface SellerLedgerRow extends LedgerEntryView {
  readonly actions: readonly LedgerRowAction[];
}

export interface SellerLedgerPage extends Omit<LedgerView, 'entries'> {
  readonly entries: readonly SellerLedgerRow[];
  /** Page numbers: the total, the page and its size. Previous/Next: total and page are null. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
}

function ledgerFilterOf(fields: Fields, sellerId: Id<'Seller'>, input: Input): LedgerListFilter {
  const kind = oneOf(fields, 'kind', input.kind, LEDGER_KINDS);
  const side = oneOf(fields, 'side', input.side, ['credit', 'debit'] as const);
  let kinds: readonly LedgerKind[] | null = null;
  if (side !== null) kinds = LEDGER_KINDS.filter((k) => isCredit(k) === (side === 'credit'));
  if (kind !== null) kinds = (kinds ?? LEDGER_KINDS).filter((k) => k === kind);
  // An order or seller order id, exact; never echoed or logged.
  const reference = idOf<'Order'>(fields, 'q', input.q);
  const { from, to } = instantWindow(fields, input);
  const amount = (path: 'minAmount' | 'maxAmount'): bigint | null => {
    const value = input[path];
    if (value === undefined || value === '') return null;
    if (typeof value === 'string' && AMOUNT.test(value)) return BigInt(value);
    fields.push({ path, code: 'format' });
    return null;
  };
  const minAmount = amount('minAmount');
  const maxAmount = amount('maxAmount');
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    fields.push({ path: 'maxAmount', code: 'range' });
  }
  return { sellerId, kinds, reference, from, to, minAmount, maxAmount };
}

const ledgerView = (entry: LedgerEntry): LedgerEntryView => ({
  entryId: entry.id,
  orderId: entry.orderId,
  sellerOrderId: entry.sellerOrderId,
  orderLineId: entry.orderLineId,
  kind: entry.kind,
  direction: isCredit(entry.kind) ? 'credit' : 'debit',
  amount: entry.amount.amount,
  rateBps: entry.rateBps,
  baseAmount: entry.baseAmount,
  sourceId: entry.sourceId,
  occurredAt: entry.occurredAt,
  recordedAt: entry.recordedAt,
});

const decodeLedgerCursor = (value: unknown): LedgerListCursor | null => {
  const decoded = decodeCursor<'LedgerEntry'>(value);
  return decoded === null ? null : { recordedAt: decoded.at, entryId: decoded.id };
};

/**
 * An admin reads one seller's ledger as a compact super list, with the balance over every row.
 * The query the older ledger card sends (`limit`, `cursor`) answers as before. An unknown seller
 * has an empty ledger.
 */
export async function listSellerLedger(
  deps: SellerPageListDependencies,
  context: CallContext,
  input: Input,
): Promise<Result<SellerLedgerPage, SellerPageListFailure>> {
  const seller = sellerOf(context, input);
  if (!seller.ok) return seller;
  const sellerId = seller.value;
  const fields: Fields = [];
  const key = unknownKey(input, LEDGER_LIST_KEYS);
  if (key !== null) fields.push({ path: key, code: 'unknown' });
  const filter = ledgerFilterOf(fields, sellerId, input);
  const { paging, sort } = pagingOf<LedgerSort['key'], LedgerListCursor>(
    fields,
    input,
    LEDGER_SORT_KEYS,
    { sort: 'recorded', pageSize: LEDGER_DEFAULT_PAGE_SIZE },
    decodeLedgerCursor,
  );
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.rate-unavailable' });
  const currency = settings.currency;
  return deps.unitOfWork.run<SellerLedgerPage, SellerPageListFailure>(
    context.market,
    async () => {
      const market = context.market;
      let entries: readonly LedgerEntry[];
      let total: number | null = null;
      let nextCursor: string | null = null;
      if (paging.kind === 'prev-next') {
        const rows = await deps.lists.ledgerPage(
          market,
          filter,
          sort,
          0,
          paging.limit + 1,
          paging.after,
        );
        entries = rows.slice(0, paging.limit);
        const last = entries[entries.length - 1];
        if (rows.length > paging.limit && last !== undefined) {
          nextCursor = cursorOf(last.recordedAt, last.id);
        }
      } else {
        entries = await deps.lists.ledgerPage(
          market,
          filter,
          sort,
          (paging.page - 1) * paging.pageSize,
          paging.pageSize,
        );
        total = await deps.lists.ledgerCount(market, filter);
      }
      const sums = await deps.ledger.sums(market, sellerId);
      const byKind: Partial<Record<LedgerKind, bigint>> = {};
      for (const sum of sums) if (sum.currency === currency) byKind[sum.kind] = sum.amount;
      return ok({
        sellerId,
        currency,
        totals: totalsOf(byKind),
        entries: entries.map((entry) => ({
          ...ledgerView(entry),
          actions: rowActions(entry, LEDGER_ROW_RULES, new Set()) as LedgerRowAction[],
        })),
        nextCursor,
        total,
        page: paging.kind === 'pages' ? paging.page : null,
        pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
      });
    },
    { readOnly: true },
  );
}

/** The panel's words for the kinds (apps/admin messages, the ledger card's `kind`). */
const KIND_LABELS: Readonly<Record<LedgerKind, string>> = Object.freeze({
  sale: 'Sale',
  shipping: 'Shipping',
  commission: 'Commission',
  'refund-sale': 'Refund of sale',
  'refund-shipping': 'Refund of shipping',
  'refund-commission': 'Commission returned',
  'dispute-debit': 'Dispute debit',
  'dispute-reinstate': 'Dispute reinstated',
});

const LEDGER_BASE_HEADERS = [
  'Recorded',
  'Kind',
  'Direction',
  'Amount',
  'Currency',
  'Order ID',
  'Seller order ID',
] as const;
const LEDGER_HEADERS: Readonly<Record<LedgerExportColumn, readonly string[]>> = {
  occurred: ['Occurred'],
  'order-line': ['Order line ID'],
  rate: ['Rate (bps)'],
  base: ['Base'],
  source: ['Source ID'],
  'entry-id': ['Entry ID'],
};

function ledgerCell(column: LedgerExportColumn, entry: LedgerEntry): ExportCell {
  switch (column) {
    case 'occurred':
      return entry.occurredAt.toString();
    case 'order-line':
      return entry.orderLineId;
    case 'rate':
      return entry.rateBps === null ? null : String(entry.rateBps);
    case 'base':
      return entry.baseAmount === null ? null : decimalOf(entry.baseAmount, entry.amount.currency);
    case 'source':
      return entry.sourceId;
    case 'entry-id':
      return entry.id;
  }
}

/**
 * One seller's ledger rows as a CSV or XLSX file: the chosen `ids` (at most 200; an id that is
 * not a row of this seller in the Market refuses the whole request) or what the selector keys
 * match, at most 10,000, in the list's sort. With `ids` the selector keys are ignored.
 */
export async function exportSellerLedger(
  deps: SellerPageListDependencies,
  context: CallContext,
  input: Input,
): Promise<Result<ExportFile, SellerPageExportFailure>> {
  const seller = sellerOf(context, input);
  if (!seller.ok) return seller;
  const sellerId = seller.value;
  const key = unknownKey(input, LEDGER_EXPORT_KEYS);
  if (key !== null)
    return err({ code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] });
  const format = parseExportFormat(input.format);
  if (!format.ok) return format;
  const columns = parseExportColumns(input.columns, LEDGER_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;
  let ids: readonly Id<'LedgerEntry'>[];
  if (input.ids !== undefined && input.ids !== '') {
    if (typeof input.ids !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'ids', code: 'type' }] });
    }
    const listed = parseExportIds(input.ids, SELLER_PAGE_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'LedgerEntry'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly LedgerEntry[], SellerPageListFailure>(
      market,
      async () => ok(await deps.lists.ledgerByIds(market, sellerId, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const known = new Set(found.value.map((entry) => entry.id));
    if (wanted.some((id) => !known.has(id))) {
      return err({ code: 'commission-payouts.ledger-entry-not-found' });
    }
    ids = wanted;
  } else {
    const fields: Fields = [];
    const filter = ledgerFilterOf(fields, sellerId, input);
    const sort: { key: LedgerSort['key']; direction: 'asc' | 'desc' } = {
      key: 'recorded',
      direction: 'desc',
    };
    sortOf(fields, input, LEDGER_SORT_KEYS, sort);
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const picked = await exportCaps(
      async () => {
        const found = await deps.lists.ledgerIds(market, filter, sort, LIST_EXPORT_MAX_ROWS + 1);
        if (found.length <= LIST_EXPORT_MAX_ROWS) return { found, total: found.length };
        return { found, total: await deps.lists.ledgerCount(market, filter) };
      },
      deps,
      context,
    );
    if (!picked.ok) return picked;
    ids = picked.value;
  }
  const chosen = columns.value;
  async function* rows(): AsyncGenerator<readonly (readonly ExportCell[])[]> {
    yield [[...LEDGER_BASE_HEADERS, ...chosen.flatMap((column) => LEDGER_HEADERS[column])]];
    for (let start = 0; start < ids.length; start += EXPORT_CHUNK) {
      const chunk = ids.slice(start, start + EXPORT_CHUNK);
      const read = await deps.unitOfWork.run<readonly LedgerEntry[], SellerPageListFailure>(
        market,
        async () => ok(await deps.lists.ledgerByIds(market, sellerId, chunk)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('commission-payouts.seller-ledger-export: the read failed');
      const byId = new Map(read.value.map((entry) => [entry.id, entry]));
      yield chunk.flatMap((id) => {
        const entry = byId.get(id);
        if (entry === undefined) return [];
        return [
          [
            entry.recordedAt.toString(),
            KIND_LABELS[entry.kind],
            isCredit(entry.kind) ? 'Credit' : 'Debit',
            decimalOf(entry.amount.amount, entry.amount.currency),
            entry.amount.currency,
            entry.orderId,
            entry.sellerOrderId,
            ...chosen.map((column) => ledgerCell(column, entry)),
          ],
        ];
      });
    }
  }
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'seller-ledger',
      sheetName: 'Ledger',
      day: deps.clock.now().toString().slice(0, 10),
      groups: rows(),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

// --- the payout holds (28) ---------------------------------------------------------------------

const HOLD_SELECTOR_KEYS = ['status', 'reason', 'origin', 'scope', 'sellerOrderId', 'from', 'to'];
const HOLD_LIST_KEYS = new Set([
  'sellerId',
  ...HOLD_SELECTOR_KEYS,
  'sort',
  'direction',
  'page',
  'pageSize',
  'cursor',
  'limit',
]);
const HOLD_EXPORT_KEYS = new Set([
  'sellerId',
  'format',
  'columns',
  'ids',
  ...HOLD_SELECTOR_KEYS,
  'sort',
  'direction',
]);

export interface SellerHoldRow extends PayoutHoldView {
  readonly actions: readonly HoldRowAction[];
}

export interface SellerHoldPage {
  readonly holds: readonly SellerHoldRow[];
  /** The seller's holds per status, whatever the filter. */
  readonly counts: HoldStatusCounts;
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
}

function holdFilterOf(fields: Fields, sellerId: Id<'Seller'>, input: Input): HoldListFilter {
  const { from, to } = instantWindow(fields, input);
  return {
    sellerId,
    status: oneOf(fields, 'status', input.status, HOLD_LIST_STATUSES),
    reason: oneOf<HoldReason>(fields, 'reason', input.reason, HOLD_REASONS),
    origin: oneOf<HoldOrigin>(fields, 'origin', input.origin, ['admin', 'system']),
    scope: oneOf(fields, 'scope', input.scope, ['seller', 'order'] as const),
    sellerOrderId: idOf<'SellerOrder'>(fields, 'sellerOrderId', input.sellerOrderId),
    from,
    to,
  };
}

const holdView = (hold: PayoutHoldRecord): PayoutHoldView => ({
  holdId: hold.id,
  sellerId: hold.sellerId,
  sellerOrderId: hold.sellerOrderId,
  reason: hold.reason,
  origin: hold.origin,
  placedAt: hold.placedAt,
  active: hold.releasedAt === null,
  releasedAt: hold.releasedAt,
  releaseReason: hold.releaseReason,
});

const decodeHoldCursor = (value: unknown): HoldListCursor | null => {
  const decoded = decodeCursor<'PayoutHold'>(value);
  return decoded === null ? null : { placedAt: decoded.at, holdId: decoded.id };
};

/** The seller must be one of the Market's (byte-identical refusal otherwise). */
async function knownSeller(
  deps: SellerPageListDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<Result<true, SellerPageListFailure>> {
  const known = await deps.sellers.exists(context, sellerId);
  if (known === 'unavailable') return err({ code: 'commission-payouts.unavailable' });
  if (!known) return err({ code: 'commission-payouts.seller-not-found' });
  return ok(true);
}

/**
 * An admin lists one seller's payout holds as a compact super list: active holds first by
 * default, 100 to a page (what the older card shows), with the counts per status.
 */
export async function listSellerHolds(
  deps: SellerPageListDependencies,
  context: CallContext,
  input: Input,
): Promise<Result<SellerHoldPage, SellerPageListFailure>> {
  const seller = sellerOf(context, input);
  if (!seller.ok) return seller;
  const sellerId = seller.value;
  const fields: Fields = [];
  const key = unknownKey(input, HOLD_LIST_KEYS);
  if (key !== null) fields.push({ path: key, code: 'unknown' });
  const filter = holdFilterOf(fields, sellerId, input);
  const { paging, sort } = pagingOf<HoldSort['key'], HoldListCursor>(
    fields,
    input,
    HOLD_SORT_KEYS,
    { sort: 'active-first', pageSize: HOLD_DEFAULT_PAGE_SIZE },
    decodeHoldCursor,
  );
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const known = await knownSeller(deps, context, sellerId);
  if (!known.ok) return known;
  const read = await deps.unitOfWork.run<
    {
      readonly holds: readonly PayoutHoldRecord[];
      readonly counts: HoldStatusCounts;
      readonly total: number | null;
      readonly nextCursor: string | null;
    },
    SellerPageListFailure
  >(
    context.market,
    async () => {
      const market = context.market;
      const counts = await deps.lists.holdCounts(market, sellerId);
      if (paging.kind === 'prev-next') {
        // Previous/Next walks newest placement first.
        const newest: HoldSort = { key: 'placed', direction: 'desc' };
        const rows = await deps.lists.holdPage(
          market,
          filter,
          newest,
          0,
          paging.limit + 1,
          paging.after,
        );
        const holds = rows.slice(0, paging.limit);
        const last = holds[holds.length - 1];
        return ok({
          holds,
          counts,
          total: null,
          nextCursor:
            rows.length > paging.limit && last !== undefined
              ? cursorOf(last.placedAt, last.id)
              : null,
        });
      }
      const holds = await deps.lists.holdPage(
        market,
        filter,
        sort,
        (paging.page - 1) * paging.pageSize,
        paging.pageSize,
      );
      const total = await deps.lists.holdCount(market, filter);
      return ok({ holds, counts, total, nextCursor: null });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const granted =
    read.value.holds.length === 0 ? new Set<string>() : await heldKeys(context, deps.probes);
  return ok({
    holds: read.value.holds.map((hold) => ({
      ...holdView(hold),
      actions: rowActions(hold, HOLD_ROW_RULES, granted) as HoldRowAction[],
    })),
    counts: read.value.counts,
    total: read.value.total,
    page: paging.kind === 'pages' ? paging.page : null,
    pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
    nextCursor: read.value.nextCursor,
  });
}

/** The panel's words (apps/admin messages, the holds card's `reason` and `release`). */
const REASON_LABELS: Readonly<Record<HoldReason, string>> = Object.freeze({
  'seller-suspended': 'Seller suspended',
  'refund-pending': 'Refund in progress',
  dispute: 'Payment disputed',
  'admin-review': 'Admin review',
  'bank-change': 'Bank change',
});
const RELEASE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  resolved: 'Resolved',
  'placed-in-error': 'Placed in error',
  'seller-reinstated': 'Seller reinstated',
  'review-complete': 'Review complete',
});

const HOLD_HEADERS: Readonly<Record<'base' | HoldExportColumn, readonly string[]>> = {
  base: ['Placed', 'Status', 'Reason', 'Placed by', 'Covers', 'Seller order ID', 'Released'],
  'release-reason': ['Release reason'],
  'hold-id': ['Hold ID'],
};

function holdCell(column: HoldExportColumn, hold: PayoutHoldRecord): ExportCell {
  switch (column) {
    case 'release-reason':
      return hold.releaseReason === null
        ? null
        : (RELEASE_LABELS[hold.releaseReason] ?? hold.releaseReason);
    case 'hold-id':
      return hold.id;
  }
}

/**
 * One seller's payout holds as a CSV or XLSX file: the chosen `ids` (at most 200; a hold that is
 * not this seller's in the Market refuses the whole request) or what the selector keys match, at
 * most 10,000, in the list's sort. With `ids` the selector keys are ignored.
 */
export async function exportSellerHolds(
  deps: SellerPageListDependencies,
  context: CallContext,
  input: Input,
): Promise<Result<ExportFile, SellerPageExportFailure>> {
  const seller = sellerOf(context, input);
  if (!seller.ok) return seller;
  const sellerId = seller.value;
  const key = unknownKey(input, HOLD_EXPORT_KEYS);
  if (key !== null)
    return err({ code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] });
  const format = parseExportFormat(input.format);
  if (!format.ok) return format;
  const columns = parseExportColumns(input.columns, HOLD_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;
  let ids: readonly Id<'PayoutHold'>[];
  if (input.ids !== undefined && input.ids !== '') {
    if (typeof input.ids !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'ids', code: 'type' }] });
    }
    const listed = parseExportIds(input.ids, SELLER_PAGE_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'PayoutHold'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const known = await knownSeller(deps, context, sellerId);
    if (!known.ok) return known;
    const found = await deps.unitOfWork.run<readonly PayoutHoldRecord[], SellerPageListFailure>(
      market,
      async () => ok(await deps.lists.holdByIds(market, sellerId, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const have = new Set(found.value.map((hold) => hold.id));
    if (wanted.some((id) => !have.has(id)))
      return err({ code: 'commission-payouts.hold-not-found' });
    ids = wanted;
  } else {
    const fields: Fields = [];
    const filter = holdFilterOf(fields, sellerId, input);
    const sort: { key: HoldSort['key']; direction: 'asc' | 'desc' } = {
      key: 'active-first',
      direction: 'desc',
    };
    sortOf(fields, input, HOLD_SORT_KEYS, sort);
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const known = await knownSeller(deps, context, sellerId);
    if (!known.ok) return known;
    const picked = await exportCaps(
      async () => {
        const found = await deps.lists.holdIds(market, filter, sort, LIST_EXPORT_MAX_ROWS + 1);
        if (found.length <= LIST_EXPORT_MAX_ROWS) return { found, total: found.length };
        return { found, total: await deps.lists.holdCount(market, filter) };
      },
      deps,
      context,
    );
    if (!picked.ok) return picked;
    ids = picked.value;
  }
  const chosen = columns.value;
  async function* rows(): AsyncGenerator<readonly (readonly ExportCell[])[]> {
    yield [[...HOLD_HEADERS.base, ...chosen.flatMap((column) => HOLD_HEADERS[column])]];
    for (let start = 0; start < ids.length; start += EXPORT_CHUNK) {
      const chunk = ids.slice(start, start + EXPORT_CHUNK);
      const read = await deps.unitOfWork.run<readonly PayoutHoldRecord[], SellerPageListFailure>(
        market,
        async () => ok(await deps.lists.holdByIds(market, sellerId, chunk)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('commission-payouts.seller-holds-export: the read failed');
      const byId = new Map(read.value.map((hold) => [hold.id, hold]));
      yield chunk.flatMap((id) => {
        const hold = byId.get(id);
        if (hold === undefined) return [];
        return [
          [
            hold.placedAt.toString(),
            hold.releasedAt === null ? 'Active' : 'Released',
            REASON_LABELS[hold.reason],
            hold.origin === 'admin' ? 'Admin' : 'System',
            hold.sellerOrderId === null ? 'The whole seller' : 'One seller order',
            hold.sellerOrderId,
            hold.releasedAt === null ? null : hold.releasedAt.toString(),
            ...chosen.map((column) => holdCell(column, hold)),
          ],
        ];
      });
    }
  }
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'seller-payout-holds',
      sheetName: 'Payout holds',
      day: deps.clock.now().toString().slice(0, 10),
      groups: rows(),
      sheetWriter: deps.sheetWriter,
    }),
  );
}
