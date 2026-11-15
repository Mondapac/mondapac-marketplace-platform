import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
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
/** What a seller may type as a tracking reference (1 to 80 printable characters). */
const TRACKING = /^[\x21-\x7e]{1,80}$/;

interface Parsed {
  readonly filter: ShipmentListFilter;
  readonly search: string | null;
  readonly sort: ShipmentSort;
  readonly page: number;
  readonly pageSize: number;
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
  if (fields.length === 0 && page * pageSize > MAX_PAGED_ROWS) {
    fields.push({ path: 'page', code: 'too-deep' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({
    filter: {
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
    sort: { key, direction },
    page,
    pageSize,
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
): Promise<Result<ShipmentListPage, ReadFailure>> {
  const parsed = parse(input ?? {});
  if (!parsed.ok) return parsed;
  const { sort, page, pageSize } = parsed.value;
  let filter = parsed.value.filter;
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
      readonly total: number;
      readonly counts: ShipmentListPage['counts'];
    },
    ReadFailure
  >(
    context.market,
    async () => {
      const [records, total, counts] = await Promise.all([
        deps.shipments.page(context.market, filter, sort, (page - 1) * pageSize, pageSize),
        deps.shipments.count(context.market, filter),
        deps.shipments.countByStage(context.market),
      ]);
      return ok({ records, total, counts });
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
    page,
    pageSize,
    searchCapped,
    searchScope,
  });
}
