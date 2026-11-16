import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  type ShipmentCursor,
  SHIPMENT_SORT_KEYS,
  SHIPMENT_STAGES,
  shipmentRowActions,
  shipmentStage,
  type ShipmentListFilter,
  type ShipmentListPage,
  type ShipmentListRecord,
  type ShipmentSort,
} from '../domain/admin-shipment-list';
import { DELIVERY_METHODS, type DeliveryAttention } from '../domain/delivery-method';
import { TRACKING } from '../domain/order';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { settled } from './order-labels';
import type { AdminShipmentListReader } from './ports/admin-shipment-list.reader';
import type { OrderLabels } from './ports/order-labels';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_PAGED_ROWS,
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  type ReadFailure,
} from './read-flow';

const logger = new Logger('AdminShipmentList');

export interface AdminShipmentListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly shipments: AdminShipmentListReader;
  readonly labels: OrderLabels;
}

/** The query of the admin Shipments list; every field is optional and checked here. */
export interface ShipmentListInput {
  /** The page from 1 (default 1); page x pageSize may not pass 10,000. */
  readonly page?: unknown;
  readonly pageSize?: unknown;
  /**
   * Previous/Next paging (List paging `prev-next`, and past row 10,000): `limit` rows from 1 to
   * 100, after `cursor` (the `nextCursor` of the page before). Newest payment first only; no
   * `page`, `pageSize`, `sort` or `direction` with it.
   */
  readonly cursor?: unknown;
  readonly limit?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly stage?: unknown;
  /** A seller order or order id, or a tracking reference, exact. */
  readonly q?: unknown;
  /** Customer or store name, 2 to 80 characters (same rules as the Orders list). */
  readonly search?: unknown;
  readonly deliveryMethod?: unknown;
  readonly attention?: unknown;
  readonly fleet?: unknown;
  readonly sellerId?: unknown;
  /** ISO instants: paid, and shipped, at or after `...From`, before `...To`. */
  readonly paidFrom?: unknown;
  readonly paidTo?: unknown;
  readonly shippedFrom?: unknown;
  readonly shippedTo?: unknown;
}

const ATTENTION: readonly (DeliveryAttention | 'any')[] = [
  'any',
  'no-carrier',
  'carrier-unknown',
  'cancel-unknown',
];
const FLEET = /^[a-z0-9_]{1,40}$/;

/** A cursor is `<paid-at ms>.<seller order id>`: opaque to callers, checked on the way in. */
export const encodeShipmentCursor = (row: ShipmentCursor): string =>
  `${row.paidAt.epochMilliseconds}.${row.sellerOrderId}`;

function decodeCursor(value: unknown): ShipmentCursor | null {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<'SellerOrder'>(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return {
    paidAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    sellerOrderId: id.value,
  };
}

type Paging =
  | { readonly kind: 'pages'; readonly page: number; readonly pageSize: number }
  | { readonly kind: 'prev-next'; readonly after: ShipmentCursor | null; readonly limit: number };

interface Parsed {
  readonly filter: ShipmentListFilter;
  readonly search: string | null;
  readonly sort: ShipmentSort;
  readonly paging: Paging;
}

function parse(input: ShipmentListInput): Result<Parsed, ReadFailure> {
  const fields: { path: string; code: string }[] = [];
  const whole = (value: unknown, min: number, max: number): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : null;
  const oneOf = <T extends string>(path: string, value: unknown, list: readonly T[]): T | null => {
    if (value === undefined) return null;
    if (list.includes(value as T)) return value as T;
    fields.push({ path, code: 'value' });
    return null;
  };

  let page = 1;
  if (input.page !== undefined) {
    const given = whole(input.page, 1, MAX_PAGED_ROWS);
    if (given === null) fields.push({ path: 'page', code: 'range' });
    else page = given;
  }
  let pageSize = DEFAULT_PAGE_SIZE;
  if (input.pageSize !== undefined) {
    const given = whole(input.pageSize, 1, MAX_PAGE_SIZE);
    if (given === null) fields.push({ path: 'pageSize', code: 'range' });
    else pageSize = given;
  }
  // Previous/Next: asked for by a cursor or a limit; it walks newest payment first only.
  const prevNext = input.cursor !== undefined || input.limit !== undefined;
  let after: ShipmentCursor | null = null;
  let limit = DEFAULT_PAGE_SIZE;
  if (prevNext) {
    for (const path of ['page', 'pageSize', 'sort', 'direction'] as const) {
      if (input[path] !== undefined) fields.push({ path, code: 'with-cursor' });
    }
    if (input.cursor !== undefined) {
      after = decodeCursor(input.cursor);
      if (after === null) fields.push({ path: 'cursor', code: 'format' });
    }
    if (input.limit !== undefined) {
      const given = whole(input.limit, 1, MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'limit', code: 'range' });
      else limit = given;
    }
  }
  const key = oneOf('sort', input.sort, SHIPMENT_SORT_KEYS) ?? 'paid';
  const direction = oneOf('direction', input.direction, ['asc', 'desc'] as const) ?? 'desc';
  const stage = oneOf('stage', input.stage, SHIPMENT_STAGES);
  const deliveryMethod = oneOf('deliveryMethod', input.deliveryMethod, DELIVERY_METHODS);
  const attention = oneOf('attention', input.attention, ATTENTION);

  let reference: string | null = null;
  let trackingRef: string | null = null;
  if (input.q !== undefined) {
    const text = typeof input.q === 'string' ? input.q.trim() : '';
    const id = parseId(text.toLowerCase());
    // Matched, never echoed or logged. An id-shaped text is read as an id.
    if (id.ok) reference = id.value;
    else if (TRACKING.test(text)) trackingRef = text;
    else fields.push({ path: 'q', code: 'format' });
  }
  let search: string | null = null;
  if (input.search !== undefined) {
    const text = typeof input.search === 'string' ? input.search.trim() : null;
    if (
      text !== null &&
      [...text].length >= MIN_SEARCH_LENGTH &&
      [...text].length <= MAX_SEARCH_LENGTH
    ) {
      search = text;
    } else fields.push({ path: 'search', code: 'length' });
  }
  let fleet: string | null = null;
  if (input.fleet !== undefined) {
    if (typeof input.fleet === 'string' && FLEET.test(input.fleet)) fleet = input.fleet;
    else fields.push({ path: 'fleet', code: 'format' });
  }
  let sellerId: Id<'Seller'> | null = null;
  if (input.sellerId !== undefined) {
    const parsed = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (parsed !== null && parsed.ok) sellerId = parsed.value;
    else fields.push({ path: 'sellerId', code: 'format' });
  }
  const instant = (path: string, value: unknown): Temporal.Instant | null => {
    if (value === undefined) return null;
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
  const range = (fromPath: string, toPath: string, from: unknown, to: unknown) => {
    const start = instant(fromPath, from);
    const end = instant(toPath, to);
    if (start !== null && end !== null && Temporal.Instant.compare(start, end) >= 0) {
      fields.push({ path: toPath, code: 'range' });
    }
    return [start, end] as const;
  };
  const [paidFrom, paidTo] = range('paidFrom', 'paidTo', input.paidFrom, input.paidTo);
  const [shippedFrom, shippedTo] = range(
    'shippedFrom',
    'shippedTo',
    input.shippedFrom,
    input.shippedTo,
  );
  if (fields.length === 0 && !prevNext && page * pageSize > MAX_PAGED_ROWS) {
    fields.push({ path: 'page', code: 'too-deep' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({
    filter: {
      ids: null,
      stage,
      reference,
      trackingRef,
      deliveryMethod,
      attention,
      fleet,
      sellerId,
      paidFrom,
      paidTo,
      shippedFrom,
      shippedTo,
      parties: null,
    },
    search,
    sort: prevNext ? { key: 'paid', direction: 'desc' } : { key, direction },
    paging: prevNext ? { kind: 'prev-next', after, limit } : { kind: 'pages', page, pageSize },
  });
}

/**
 * The seller orders of the Market's paid orders for the admin Shipments list: one page with its
 * total and the per-stage counts, then the store and customer names (advisory). The search is
 * resolved by the owning modules before the read unit and fails closed, as on the Orders list.
 */
export async function listShipments(
  deps: AdminShipmentListDependencies,
  context: CallContext,
  input: ShipmentListInput,
  ids: readonly string[] | null = null,
): Promise<Result<ShipmentListPage, ReadFailure>> {
  const parsed = parse(input ?? {});
  if (!parsed.ok) return parsed;
  const { sort, paging } = parsed.value;
  // An export's selected rows narrow the list's own filter (an AND).
  let filter = { ...parsed.value.filter, ids };
  let searchCapped = false;
  let searchScope: ShipmentListPage['searchScope'] = null;
  if (parsed.value.search !== null) {
    try {
      const [customers, stores] = await Promise.all([
        deps.labels.customerAccountsMatching(context, parsed.value.search),
        deps.labels.sellersMatching(context, parsed.value.search),
      ]);
      filter = {
        ...filter,
        parties: { accountIds: customers.accountIds, sellerIds: stores.sellerIds },
      };
      searchCapped = customers.capped || stores.capped;
      searchScope = customers.searched ? 'customers-and-stores' : 'stores';
    } catch {
      // Never log the text or the error (it may name the term).
      logger.warn({
        msg: 'ordering.admin-shipment-search.lookup-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'ordering.search-unavailable' });
    }
  }
  const read = await deps.unitOfWork.run<
    {
      readonly records: readonly ShipmentListRecord[];
      readonly total: number | null;
      readonly nextCursor: string | null;
      readonly counts: ShipmentListPage['counts'];
    },
    ReadFailure
  >(
    context.market,
    async () => {
      if (paging.kind === 'prev-next') {
        // One row more than asked tells whether a next page exists.
        const [rows, counts] = await Promise.all([
          deps.shipments.page(context.market, filter, sort, 0, paging.limit + 1, paging.after),
          deps.shipments.countByStage(context.market),
        ]);
        const records = rows.slice(0, paging.limit);
        const last = records[records.length - 1];
        const nextCursor =
          rows.length > paging.limit && last !== undefined
            ? encodeShipmentCursor({ paidAt: last.paidAt, sellerOrderId: last.sellerOrderId })
            : null;
        return ok({ records, total: null, nextCursor, counts });
      }
      const { page, pageSize } = paging;
      const [records, counts] = await Promise.all([
        deps.shipments.page(context.market, filter, sort, (page - 1) * pageSize, pageSize),
        deps.shipments.countByStage(context.market),
      ]);
      // A tab with no other filter has its count already; only a narrower filter counts again.
      const total =
        tabTotal(filter, counts) ?? (await deps.shipments.count(context.market, filter));
      return ok({ records, total, nextCursor: null, counts });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { records } = read.value;
  const [storeAnswer, customerAnswer] =
    records.length === 0
      ? [undefined, undefined]
      : await Promise.allSettled([
          deps.labels.storeNamesOf(context, [...new Set(records.map((r) => r.sellerId))]),
          deps.labels.customersOf(context, [...new Set(records.map((r) => r.accountId))]),
        ]);
  const storeNames =
    storeAnswer === undefined ? undefined : settled(context, 'store-names', storeAnswer);
  const customers =
    customerAnswer === undefined ? undefined : settled(context, 'customers', customerAnswer);
  return ok({
    rows: records.map((record) => ({
      ...record,
      stage: shipmentStage(record),
      storeName: storeNames?.get(record.sellerId) ?? null,
      customer: customers?.get(record.accountId) ?? null,
      actions: shipmentRowActions(record),
    })),
    counts: read.value.counts,
    total: read.value.total,
    page: paging.kind === 'pages' ? paging.page : null,
    pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
    nextCursor: read.value.nextCursor,
    searchCapped,
    searchScope,
  });
}

/**
 * The total of a filter that is only a tab (a stage, `attention=any`, or nothing), read from the
 * tab counts; null when the filter narrows further and must be counted.
 */
export function tabTotal(
  filter: ShipmentListFilter,
  counts: ShipmentListPage['counts'],
): number | null {
  const { stage, attention, ...rest } = filter;
  if (Object.values(rest).some((value) => value !== null)) return null;
  if (stage === null && attention === null) {
    return counts.toPrepare + counts.ready + counts.shipped + counts.delivered + counts.refunded;
  }
  if (stage === null && attention === 'any') return counts.attention;
  if (attention !== null) return null;
  switch (stage) {
    case 'to-prepare':
      return counts.toPrepare;
    case 'ready':
      return counts.ready;
    case 'shipped':
      return counts.shipped;
    case 'delivered':
      return counts.delivered;
    case 'refunded':
      return counts.refunded;
    default:
      return null;
  }
}
