import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { OrderStatus } from '../domain/order';
import {
  adminOrderView,
  orderView,
  type AdminOrderView,
  type LabelledAdminOrderView,
  type OrderPageView,
  type OrderView,
} from '../domain/order-views';
import type { OrderingDependencies } from './checkout-flow';
import { labelAdminOrders } from './order-labels';
import type { OrderPage } from './ports/order.repository';

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
}

function pageOf(
  input: ListInput,
  allowStatus: boolean,
): Result<{ page: OrderPage; status: OrderStatus | null }, ReadFailure> {
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
    if (allowStatus && STATUSES.includes(input.status as OrderStatus)) {
      status = input.status as OrderStatus;
    } else fields.push({ path: 'status', code: 'value' });
  }
  return fields.length > 0
    ? err({ code: 'validation.failed', fields })
    : ok({ page: { limit, after }, status });
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

const parseOrderId = (value: unknown): Result<Id<'Order'>, ReadFailure> => {
  const parsed = typeof value === 'string' ? parseId<'Order'>(value) : null;
  return parsed !== null && parsed.ok
    ? ok(parsed.value)
    : err({ code: 'validation.failed', fields: [{ path: 'orderId', code: 'format' }] });
};

/** The customer's own order. Unknown and foreign are one answer. */
export async function viewOwnOrder(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: { readonly orderId: unknown },
): Promise<Result<OrderView, ReadFailure>> {
  const orderId = parseOrderId(input?.orderId);
  if (!orderId.ok) return orderId;
  return deps.unitOfWork.run<OrderView, ReadFailure>(
    context.market,
    async () => {
      const order = await deps.orders.findOwn(context.market, orderId.value, accountId);
      return order === null
        ? err({ code: 'ordering.order-not-found' } as const)
        : ok(orderView(order));
    },
    { readOnly: true },
  );
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
): Promise<Result<OrderPageView<LabelledAdminOrderView>, ReadFailure>> {
  const parsed = pageOf(input ?? {}, true);
  if (!parsed.ok) return parsed;
  const { page, status } = parsed.value;
  const read = await deps.unitOfWork.run<OrderPageView<AdminOrderView>, ReadFailure>(
    context.market,
    async () => {
      const rows = await deps.orders.listAll(
        context.market,
        { status },
        { ...page, limit: page.limit + 1 },
      );
      return ok(cut(rows.map(adminOrderView), page.limit));
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  return ok({
    orders: await labelAdminOrders(deps.labels, context, read.value.orders),
    nextCursor: read.value.nextCursor,
  });
}
