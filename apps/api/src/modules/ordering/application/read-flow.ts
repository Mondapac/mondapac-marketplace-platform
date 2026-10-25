import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { OrderStatus, OrderState, ShipTo } from '../domain/order';
import {
  adminOrderView,
  orderView,
  type AdminOrderPageView,
  type AdminOrderView,
  type LabelledAdminOrderView,
  type OrderStatusCounts,
  type OrderPageView,
  type OrderView,
  type OwnOrderView,
  type OwnTrackingLinkView,
} from '../domain/order-views';
import type { OrderingDependencies } from './checkout-flow';
import { labelAdminOrders } from './order-labels';
import type { OrderFilter, OrderPage } from './ports/order.repository';
import { openPickupCodes, storedPickupCodes } from './pickup-flow';

export type ReadFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'access.denied' }
  | { readonly code: 'ordering.order-not-found' };

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
const STATUSES: readonly OrderStatus[] = ['pending-payment', 'confirmed', 'cancelled'];

/** A page cursor is `<created-at ms>.<order id>`: opaque to callers, checked on the way in. */
export const encodeCursor = (createdAt: Temporal.Instant, id: string): string =>
  `${createdAt.epochMilliseconds}.${id}`;

function decodeCursor(value: string): OrderPage['after'] | undefined {
  const match = /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value);
  const id = match === null ? null : parseId<'Order'>(match[2]!);
  if (match === null || id === null || !id.ok) return undefined;
  return { createdAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

export interface ListInput {
  readonly limit?: unknown;
  readonly cursor?: unknown;
  readonly status?: unknown;
  /** Admin only: an order id or a seller order id (the reference in the emails), exact. */
  readonly q?: unknown;
}

function pageOf(
  input: ListInput,
  allowFilters: boolean,
): Result<{ page: OrderPage; filter: OrderFilter }, ReadFailure> {
  const fields: { path: string; code: string }[] = [];
  let limit = DEFAULT_PAGE_SIZE;
  if (input.limit !== undefined) {
    if (
      typeof input.limit === 'number' &&
      Number.isSafeInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= MAX_PAGE_SIZE
    ) {
      limit = input.limit;
    } else fields.push({ path: 'limit', code: 'range' });
  }
  let after: OrderPage['after'] = null;
  if (input.cursor !== undefined) {
    const decoded = typeof input.cursor === 'string' ? decodeCursor(input.cursor) : undefined;
    if (decoded === undefined) fields.push({ path: 'cursor', code: 'format' });
    else after = decoded;
  }
  let status: OrderStatus | null = null;
  if (input.status !== undefined) {
    if (allowFilters && STATUSES.includes(input.status as OrderStatus)) {
      status = input.status as OrderStatus;
    } else fields.push({ path: 'status', code: 'value' });
  }
  let reference: string | null = null;
  if (input.q !== undefined) {
    // Any id of the right shape; a trimmed, lower-cased copy is matched, never echoed.
    const parsed = typeof input.q === 'string' ? parseId(input.q.trim().toLowerCase()) : null;
    if (allowFilters && parsed !== null && parsed.ok) reference = parsed.value;
    else fields.push({ path: 'q', code: 'format' });
  }
  return fields.length > 0
    ? err({ code: 'validation.failed', fields })
    : ok({ page: { limit, after }, filter: { status, reference } });
}

function cut<T extends { orderId: Id<'Order'>; createdAt: Temporal.Instant }>(
  rows: readonly T[],
  limit: number,
): OrderPageView<T> {
  const orders = rows.slice(0, limit);
  const last = orders[orders.length - 1];
  return {
    orders,
    nextCursor:
      rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.orderId) : null,
  };
}

export const parseOrderId = (value: unknown): Result<Id<'Order'>, ReadFailure> => {
  const parsed = typeof value === 'string' ? parseId<'Order'>(value) : null;
  return parsed !== null && parsed.ok
    ? ok(parsed.value)
    : err({ code: 'validation.failed', fields: [{ path: 'orderId', code: 'format' }] });
};

const logger = new Logger('OrderShipTo');

/**
 * Opens an order's sealed delivery address. None recorded, or the account's key destroyed
 * (erasure), is null: the order stays readable without it. A copy that fails its integrity check
 * is logged as a code with the order's ids only and answered as null, so a seller's shipment that
 * was already saved never comes back as an error.
 */
export async function openShipTo(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  sealed: string | null,
): Promise<ShipTo | null> {
  if (sealed === null) return null;
  try {
    const opened = await deps.shipTo.open(context.market, accountId, sealed);
    return opened.ok ? opened.value : null;
  } catch (error) {
    logger.error({
      msg: 'ordering.ship-to-unreadable',
      errorName: error instanceof Error ? error.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return null;
  }
}

/**
 * The carrier tracking links of the shipped parts of the buyer's own order, asked of shipping
 * under the buyer's context. Called after the read unit. A failure is no link, never an error:
 * the page works without one. Only an https link is passed on.
 */
async function trackingLinksOf(
  deps: OrderingDependencies,
  context: CallContext,
  order: OrderState,
): Promise<readonly OwnTrackingLinkView[]> {
  const shipped = order.sellerOrders.filter(
    (seller) => seller.fulfilment === 'shipped' && seller.carrier !== null,
  );
  if (order.status !== 'confirmed' || shipped.length === 0) return [];
  try {
    const found = await deps.shipping.carrierTrackingLinks(
      context,
      shipped.map((seller) => seller.id),
    );
    if (!found.ok) return [];
    return shipped.flatMap((seller) => {
      const url = found.value.get(seller.id);
      return url === undefined || !url.startsWith('https://')
        ? []
        : [{ sellerId: seller.sellerId, url }];
    });
  } catch {
    return [];
  }
}

/** The customer's own order, with its delivery address. Unknown and foreign are one answer. */
export async function viewOwnOrder(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: { readonly orderId: unknown },
): Promise<Result<OwnOrderView, ReadFailure>> {
  const orderId = parseOrderId(input?.orderId);
  if (!orderId.ok) return orderId;
  const read = await deps.unitOfWork.run<
    { readonly order: OrderState; readonly stored: Awaited<ReturnType<typeof storedPickupCodes>> },
    ReadFailure
  >(
    context.market,
    async () => {
      const order = await deps.orders.findOwn(context.market, orderId.value, accountId);
      return order === null
        ? err({ code: 'ordering.order-not-found' } as const)
        : ok({ order, stored: await storedPickupCodes(deps, context.market, order) });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { order, stored } = read.value;
  return ok({
    ...orderView(order),
    shipTo: await openShipTo(deps, context, accountId, order.shipToSealed),
    // The buyer's own codes, opened after the unit: only this view ever shows one.
    pickupCodes: await openPickupCodes(deps, context, accountId, order, stored),
    trackingLinks: await trackingLinksOf(deps, context, order),
  });
}

export async function listOwnOrders(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: ListInput,
): Promise<Result<OrderPageView<OrderView>, ReadFailure>> {
  const parsed = pageOf(input ?? {}, false);
  if (!parsed.ok) return parsed;
  const { page } = parsed.value;
  return deps.unitOfWork.run<OrderPageView<OrderView>, ReadFailure>(
    context.market,
    async () => {
      const rows = await deps.orders.listOwn(context.market, accountId, {
        ...page,
        limit: page.limit + 1,
      });
      return ok(cut(rows.map(orderView), page.limit));
    },
    { readOnly: true },
  );
}

export async function viewAnyOrder(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly orderId: unknown },
): Promise<Result<LabelledAdminOrderView, ReadFailure>> {
  const orderId = parseOrderId(input?.orderId);
  if (!orderId.ok) return orderId;
  const read = await deps.unitOfWork.run<AdminOrderView, ReadFailure>(
    context.market,
    async () => {
      const order = await deps.orders.findById(context.market, orderId.value);
      return order === null
        ? err({ code: 'ordering.order-not-found' } as const)
        : ok(adminOrderView(order));
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const [labelled] = await labelAdminOrders(deps.labels, context, [read.value]);
  return ok(labelled!);
}

export async function listAllOrders(
  deps: OrderingDependencies,
  context: CallContext,
  input: ListInput,
): Promise<Result<AdminOrderPageView, ReadFailure>> {
  const parsed = pageOf(input ?? {}, true);
  if (!parsed.ok) return parsed;
  const { page, filter } = parsed.value;
  const read = await deps.unitOfWork.run<
    OrderPageView<AdminOrderView> & { readonly counts: OrderStatusCounts },
    ReadFailure
  >(
    context.market,
    async () => {
      const rows = await deps.orders.listAll(context.market, filter, {
        ...page,
        limit: page.limit + 1,
      });
      return ok({
        ...cut(rows.map(adminOrderView), page.limit),
        counts: await deps.orders.countAll(context.market),
      });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  return ok({
    orders: await labelAdminOrders(deps.labels, context, read.value.orders),
    nextCursor: read.value.nextCursor,
    counts: read.value.counts,
  });
}
