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
  type ExportInputFailure,
  type ExportTooLarge,
  type SheetWriter,
} from '../../../platform/list-export';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { PayoutListCursor, PayoutListFilter, PayoutSort } from '../domain/admin-payout-list';
import {
  OWN_PAYOUT_EXPORT_COLUMNS,
  OWN_PAYOUT_SORT_KEYS,
  type OwnPayoutExportColumn,
  type OwnPayoutRowAction,
} from '../domain/own-payout-list';
import { PAYOUT_STATES, type Payout, type PayoutState } from '../domain/payout';
import { decimalOf } from './admin-payout-list-flow';
import {
  ownView,
  SELLER_STATUS,
  type OwnPayoutView,
  type SellerPayoutState,
} from './payout-seller-flow';
import type { AdminPayoutListReader } from './ports/admin-payout-list.reader';
import { sellerIdOf } from './rate-flow';
import {
  cursorOf,
  decodeCursor,
  idOf,
  instantWindow,
  oneOf,
  pagingOf,
  sortOf,
  unknownKey,
  type Fields,
  type Input,
} from './seller-page-lists-flow';

// The seller panel's Earnings › Payouts list (super list phase 4, list 33) and its export: the
// signed-in seller's own payouts, voided ones hidden, as a super list (status tabs, search by
// payout id, filters, sort, paging, export). Read only. The seller id is always the session's.

export interface OwnPayoutListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly payouts: AdminPayoutListReader;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

/** The seller's tabs: every status the seller sees (a voided payout never happened). */
export const OWN_PAYOUT_STATUSES: readonly SellerPayoutState[] = [
  'scheduled',
  'awaiting-approval',
  'on-its-way',
  'paid',
  'not-sent',
  'failed',
  'settled',
];

/** The payout states behind each status the seller sees. */
const STATUS_STATES: Readonly<Record<SellerPayoutState, readonly PayoutState[]>> =
  Object.fromEntries(
    OWN_PAYOUT_STATUSES.map((status) => [
      status,
      PAYOUT_STATES.filter((state) => SELLER_STATUS[state] === status),
    ]),
  ) as unknown as Record<SellerPayoutState, readonly PayoutState[]>;
const SHOWN_STATES: readonly PayoutState[] = PAYOUT_STATES.filter(
  (state) => SELLER_STATUS[state] !== null,
);

/** The Previous/Next page of the older Earnings card: 50 rows unless `limit` says otherwise. */
export const OWN_PAYOUT_DEFAULT_LIMIT = 50;
export const OWN_PAYOUT_DEFAULT_PAGE_SIZE = 25;
export const OWN_PAYOUT_EXPORT_MAX_IDS = 200;
const EXPORT_CHUNK = 500;
const AMOUNT = /^[0-9]{1,15}$/;

export type OwnPayoutListFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'commission-payouts.payout-not-found' };

export type OwnPayoutExportFailure = OwnPayoutListFailure | ExportInputFailure | ExportTooLarge;

export interface OwnPayoutRow extends OwnPayoutView {
  readonly actions: readonly OwnPayoutRowAction[];
}

export interface OwnPayoutListPage {
  readonly payouts: readonly OwnPayoutRow[];
  /** The seller's payouts per status (the tabs, `all` included), whatever the filter. */
  readonly counts: Readonly<Record<'all' | SellerPayoutState, number>>;
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
}

const SELECTOR_KEYS = ['status', 'q', 'from', 'to', 'minAmount', 'maxAmount'];
const LIST_KEYS = new Set([
  ...SELECTOR_KEYS,
  'sort',
  'direction',
  'page',
  'pageSize',
  'cursor',
  'limit',
]);
const EXPORT_KEYS = new Set(['format', 'columns', 'ids', ...SELECTOR_KEYS, 'sort', 'direction']);

const ownSeller = (context: CallContext): Id<'Seller'> | null =>
  context.actor.kind === 'authenticated' && context.actor.population === 'seller'
    ? sellerIdOf(context.actor.sellerId)
    : null;

/** The selector of the list (status, payout id, window, amounts), without the seller. */
export interface OwnPayoutSelector {
  readonly status: SellerPayoutState | null;
  readonly payoutId: Id<'Payout'> | null;
  readonly from: PayoutListFilter['from'];
  readonly to: PayoutListFilter['to'];
  readonly minAmount: bigint | null;
  readonly maxAmount: bigint | null;
}

/**
 * The selector keys (status, `q`, the filters) shared by the list, the export and the saved
 * filters (seller routes of `lists`).
 */
export function parseOwnPayoutSelector(input: Input, fields: Fields): OwnPayoutSelector {
  const status = oneOf(fields, 'status', input.status, OWN_PAYOUT_STATUSES);
  // A payout id, exact; never echoed or logged.
  const payoutId = idOf<'Payout'>(fields, 'q', input.q);
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
  return { status, payoutId, from, to, minAmount, maxAmount };
}

function filterOf(fields: Fields, sellerId: Id<'Seller'>, input: Input): PayoutListFilter {
  const { status, payoutId, from, to, minAmount, maxAmount } = parseOwnPayoutSelector(
    input,
    fields,
  );
  return {
    states: status === null ? SHOWN_STATES : STATUS_STATES[status],
    state: null,
    payoutId,
    sellerId,
    approvalMode: null,
    from,
    to,
    minAmount,
    maxAmount,
    sellerIds: null,
  };
}

const decodeListCursor = (value: unknown): PayoutListCursor | null => {
  const decoded = decodeCursor<'Payout'>(value);
  return decoded === null ? null : { createdAt: decoded.at, payoutId: decoded.id };
};

/**
 * The signed-in seller's payouts as a super list. The query the older Earnings card sends
 * (`limit`, `cursor`) answers as before: Previous/Next, newest first.
 */
export async function listOwnPayoutPage(
  deps: OwnPayoutListDependencies,
  context: CallContext,
  input: Input,
): Promise<Result<OwnPayoutListPage, OwnPayoutListFailure>> {
  const sellerId = ownSeller(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const fields: Fields = [];
  const key = unknownKey(input ?? {}, LIST_KEYS);
  if (key !== null) fields.push({ path: key, code: 'unknown' });
  const filter = filterOf(fields, sellerId, input ?? {});
  const { paging, sort } = pagingOf<PayoutSort['key'], PayoutListCursor>(
    fields,
    input ?? {},
    OWN_PAYOUT_SORT_KEYS,
    { sort: 'created', pageSize: OWN_PAYOUT_DEFAULT_PAGE_SIZE, limit: OWN_PAYOUT_DEFAULT_LIMIT },
    decodeListCursor,
  );
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return deps.unitOfWork.run<OwnPayoutListPage, OwnPayoutListFailure>(
    context.market,
    async () => {
      const market = context.market;
      const byState = await deps.payouts.countByState(market, sellerId);
      const counts = { all: 0 } as Record<'all' | SellerPayoutState, number>;
      for (const status of OWN_PAYOUT_STATUSES) counts[status] = 0;
      for (const state of SHOWN_STATES) {
        counts[SELLER_STATUS[state]!] += byState[state];
        counts.all += byState[state];
      }
      let rows: readonly Payout[];
      let total: number | null = null;
      let nextCursor: string | null = null;
      if (paging.kind === 'prev-next') {
        const read = await deps.payouts.page(
          market,
          filter,
          { key: 'created', direction: 'desc' },
          0,
          paging.limit + 1,
          paging.after,
        );
        rows = read.slice(0, paging.limit);
        const last = rows[rows.length - 1];
        if (read.length > paging.limit && last !== undefined) {
          nextCursor = cursorOf(last.createdAt, last.id);
        }
      } else {
        rows = await deps.payouts.page(
          market,
          filter,
          sort,
          (paging.page - 1) * paging.pageSize,
          paging.pageSize,
        );
        total = await deps.payouts.count(market, filter);
      }
      return ok({
        payouts: rows.map((payout) => ({ ...ownView(payout), actions: ['open'] as const })),
        counts,
        total,
        page: paging.kind === 'pages' ? paging.page : null,
        pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
        nextCursor,
      });
    },
    { readOnly: true },
  );
}

/** The seller panel's words for the statuses (apps/seller messages, the payouts table). */
const STATUS_LABELS: Readonly<Record<SellerPayoutState, string>> = Object.freeze({
  scheduled: 'Planned',
  'awaiting-approval': 'Waiting for our check',
  'on-its-way': 'Sending',
  paid: 'Paid',
  'not-sent': 'Not sent',
  failed: 'Failed',
  settled: 'Settled against what you owe',
});

const BASE_HEADERS = ['Payout ID', 'Status', 'Amount', 'Currency', 'Created'] as const;
const HEADERS: Readonly<Record<OwnPayoutExportColumn, string>> = {
  gross: 'Earned',
  netted: 'Kept against what you owed',
  slot: 'Planned for',
  updated: 'Last change',
};

function cellOf(column: OwnPayoutExportColumn, payout: Payout): ExportCell {
  switch (column) {
    case 'gross':
      return decimalOf(payout.gross, payout.currency);
    case 'netted':
      return decimalOf(payout.netted, payout.currency);
    case 'slot':
      return payout.slotAt.toString();
    case 'updated':
      return payout.stateChangedAt.toString();
  }
}

/**
 * The signed-in seller's payouts as a CSV or XLSX file: the chosen `ids` (at most 200; an id that
 * is not one of the seller's shown payouts refuses the whole request as not found) or what the
 * selector keys match, at most 10,000, in the list's sort. With `ids` the selector keys are
 * ignored.
 */
export async function exportOwnPayouts(
  deps: OwnPayoutListDependencies,
  context: CallContext,
  input: Input,
): Promise<Result<ExportFile, OwnPayoutExportFailure>> {
  const sellerId = ownSeller(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const key = unknownKey(input ?? {}, EXPORT_KEYS);
  if (key !== null) {
    return err({ code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] });
  }
  const format = parseExportFormat(input.format);
  if (!format.ok) return format;
  const columns = parseExportColumns(input.columns, OWN_PAYOUT_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;
  // Another seller's payout, or a voided one, is never the caller's to read.
  const mine = (payout: Payout) =>
    payout.sellerId === sellerId && SELLER_STATUS[payout.state] !== null;
  let ids: readonly Id<'Payout'>[];
  if (input.ids !== undefined && input.ids !== '') {
    if (typeof input.ids !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'ids', code: 'type' }] });
    }
    const listed = parseExportIds(input.ids, OWN_PAYOUT_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'Payout'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly Payout[], OwnPayoutListFailure>(
      market,
      async () => ok(await deps.payouts.byIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const known = new Set(found.value.filter(mine).map((payout) => payout.id));
    if (wanted.some((id) => !known.has(id))) {
      return err({ code: 'commission-payouts.payout-not-found' });
    }
    ids = wanted;
  } else {
    const fields: Fields = [];
    const filter = filterOf(fields, sellerId, input);
    const sort: { key: PayoutSort['key']; direction: 'asc' | 'desc' } = {
      key: 'created',
      direction: 'desc',
    };
    sortOf(fields, input, OWN_PAYOUT_SORT_KEYS as unknown as readonly PayoutSort['key'][], sort);
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const picked = await deps.unitOfWork.run<
      { readonly found: readonly Id<'Payout'>[]; readonly total: number },
      OwnPayoutListFailure
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
  const chosen = columns.value;
  async function* rows(): AsyncGenerator<readonly (readonly ExportCell[])[]> {
    yield [[...BASE_HEADERS, ...chosen.map((column) => HEADERS[column])]];
    for (let start = 0; start < ids.length; start += EXPORT_CHUNK) {
      const chunk = ids.slice(start, start + EXPORT_CHUNK);
      const read = await deps.unitOfWork.run<readonly Payout[], OwnPayoutListFailure>(
        market,
        async () => ok(await deps.payouts.byIds(market, chunk)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('commission-payouts.own-payouts-export: the read failed');
      const byId = new Map(read.value.filter(mine).map((payout) => [payout.id, payout]));
      yield chunk.flatMap((id) => {
        const payout = byId.get(id);
        if (payout === undefined) return [];
        return [
          [
            payout.id,
            STATUS_LABELS[SELLER_STATUS[payout.state]!],
            decimalOf(payout.transfer, payout.currency),
            payout.currency,
            payout.createdAt.toString(),
            ...chosen.map((column) => cellOf(column, payout)),
          ],
        ];
      });
    }
  }
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'payouts',
      sheetName: 'Payouts',
      day: deps.clock.now().toString().slice(0, 10),
      groups: rows(),
      sheetWriter: deps.sheetWriter,
    }),
  );
}
