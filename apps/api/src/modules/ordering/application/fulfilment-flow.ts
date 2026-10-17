import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { OutboxWriteRefusedError } from '../../../platform/events/outbox-writer';
import { OrderShipped } from '../domain/events';
import { markDelivered, markShipped, parseShipment, type Fulfilment } from '../domain/order';
import {
  sellerOrderDetailView,
  type LabelledSellerOrderDetailView,
  type LabelledSellerOrderPageView,
  type SellerOrderCounts,
  type SellerOrderDetailView,
  type SellerOrderPageView,
} from '../domain/order-views';
import type { OrderingDependencies } from './checkout-flow';
import { labelSellerOrders } from './order-labels';
import type { SellerOrderPage } from './ports/order.repository';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './read-flow';

// The seller's side of an order once it is paid: see it, record the shipment (carrier and an
// optional tracking reference, SHP-01), record the delivery. Each step happens once and in that
// order; the seller sees only the seller orders of its own shop. Inventory learns of a shipment
// from the worker (`recordShipments`), not from the seller's request.

export type FulfilmentFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'ordering.seller-order-not-found' }
  /** The seller order is not at the step the request needs (already shipped, not yet shipped). */
  | { readonly code: 'ordering.fulfilment-conflict' };

/** The seller of an authenticated seller session; null for any other actor (fail closed). */
function sellerOf(context: CallContext): Id<'Seller'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') return null;
  const parsed = typeof actor.sellerId === 'string' ? parseId<'Seller'>(actor.sellerId) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

const parseSellerOrderId = (value: unknown): Result<Id<'SellerOrder'>, FulfilmentFailure> => {
  const parsed = typeof value === 'string' ? parseId<'SellerOrder'>(value) : null;
  return parsed !== null && parsed.ok
    ? ok(parsed.value)
    : err({ code: 'validation.failed', fields: [{ path: 'sellerOrderId', code: 'format' }] });
};

/** A page cursor is `<paid-at ms>.<seller order id>`: opaque to callers, checked on the way in. */
export const encodeSellerCursor = (confirmedAt: Temporal.Instant, id: string): string =>
  `${confirmedAt.epochMilliseconds}.${id}`;

function decodeSellerCursor(value: string): SellerOrderPage['after'] | undefined {
  const match = /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value);
  const id = match === null ? null : parseId<'SellerOrder'>(match[2]!);
  if (match === null || id === null || !id.ok) return undefined;
  return { confirmedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

export interface SellerListInput {
  readonly limit?: unknown;
  readonly cursor?: unknown;
  /** One fulfilment step: `to-ship`, `shipped` or `delivered`. */
  readonly status?: unknown;
}

const FULFILMENTS: readonly Fulfilment[] = ['to-ship', 'shipped', 'delivered'];

/** The seller's paid seller orders, newest payment first. */
export async function listSellerOrders(
  deps: OrderingDependencies,
  context: CallContext,
  input: SellerListInput,
): Promise<Result<LabelledSellerOrderPageView, FulfilmentFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const fields: { path: string; code: string }[] = [];
  let limit = DEFAULT_PAGE_SIZE;
  if (input?.limit !== undefined) {
    if (
      typeof input.limit === 'number' &&
      Number.isSafeInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= MAX_PAGE_SIZE
    ) {
      limit = input.limit;
    } else fields.push({ path: 'limit', code: 'range' });
  }
  let after: SellerOrderPage['after'] = null;
  if (input?.cursor !== undefined) {
    const decoded = typeof input.cursor === 'string' ? decodeSellerCursor(input.cursor) : undefined;
    if (decoded === undefined) fields.push({ path: 'cursor', code: 'format' });
    else after = decoded;
  }
  let fulfilment: Fulfilment | null = null;
  if (input?.status !== undefined) {
    if (FULFILMENTS.includes(input.status as Fulfilment)) fulfilment = input.status as Fulfilment;
    else fields.push({ path: 'status', code: 'value' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const read = await deps.unitOfWork.run<
    SellerOrderPageView & { readonly counts: SellerOrderCounts },
    FulfilmentFailure
  >(
    context.market,
    async () => {
      const rows = await deps.orders.listForSeller(
        context.market,
        sellerId,
        { fulfilment },
        { limit: limit + 1, after },
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return ok({
        sellerOrders: page.map(sellerOrderDetailView),
        counts: await deps.orders.countForSeller(context.market, sellerId),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeSellerCursor(last.confirmedAt, last.sellerOrder.id)
            : null,
      });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  return ok({
    sellerOrders: await labelSellerOrders(deps.labels, context, read.value.sellerOrders),
    nextCursor: read.value.nextCursor,
    counts: read.value.counts,
  });
}

export async function viewSellerOrder(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<LabelledSellerOrderDetailView, FulfilmentFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const sellerOrderId = parseSellerOrderId(input?.sellerOrderId);
  if (!sellerOrderId.ok) return sellerOrderId;
  return labelled(
    deps,
    context,
    await deps.unitOfWork.run<SellerOrderDetailView, FulfilmentFailure>(
      context.market,
      async () => {
        const record = await deps.orders.findForSeller(
          context.market,
          sellerId,
          sellerOrderId.value,
        );
        return record === null
          ? err({ code: 'ordering.seller-order-not-found' } as const)
          : ok(sellerOrderDetailView(record));
      },
      { readOnly: true },
    ),
  );
}

/** Records the shipment of a paid seller order: carrier, optional tracking reference. */
export async function shipSellerOrder(
  deps: OrderingDependencies,
  context: CallContext,
  input: {
    readonly sellerOrderId: unknown;
    readonly carrier: unknown;
    readonly trackingRef: unknown;
  },
): Promise<Result<LabelledSellerOrderDetailView, FulfilmentFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const sellerOrderId = parseSellerOrderId(input?.sellerOrderId);
  const shipment = parseShipment({ carrier: input?.carrier, trackingRef: input?.trackingRef });
  const fields = [
    ...(sellerOrderId.ok ? [] : [{ path: 'sellerOrderId', code: 'format' }]),
    ...(shipment.ok ? [] : shipment.fields),
  ];
  if (!sellerOrderId.ok || !shipment.ok) return err({ code: 'validation.failed', fields });
  const now = deps.clock.now();
  const done = await deps.unitOfWork.run<SellerOrderDetailView, FulfilmentFailure>(
    context.market,
    async () => {
      const record = await deps.orders.findForSeller(context.market, sellerId, sellerOrderId.value);
      if (record === null) return err({ code: 'ordering.seller-order-not-found' } as const);
      const shipped = markShipped(record.sellerOrder, shipment.shipment, now);
      if (shipped === null) return err({ code: 'ordering.fulfilment-conflict' } as const);
      const saved = await deps.orders.saveFulfilment(
        context.market,
        shipped,
        record.sellerOrder.fulfilment,
      );
      if (saved !== 'saved') return err({ code: 'ordering.fulfilment-conflict' } as const);
      // Written with the shipment, once per seller order (a repeat finds it shipped and conflicts).
      // A refused event rolls the shipment back: the seller sees a conflict and tries again.
      try {
        await deps.outbox.append(context, [
          OrderShipped.record({
            aggregateId: shipped.id,
            aggregateVersion: 1,
            occurredAt: now,
            payload: {
              orderId: record.orderId,
              sellerOrderId: shipped.id,
              sellerId: shipped.sellerId,
            },
          }),
        ]);
      } catch (error) {
        if (error instanceof OutboxWriteRefusedError) {
          return err({ code: 'ordering.fulfilment-conflict' } as const);
        }
        throw error;
      }
      return ok(sellerOrderDetailView({ ...record, sellerOrder: shipped }));
    },
  );
  return labelled(deps, context, done);
}

/** Records the delivery of a shipped seller order. */
export async function deliverSellerOrder(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<LabelledSellerOrderDetailView, FulfilmentFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const sellerOrderId = parseSellerOrderId(input?.sellerOrderId);
  if (!sellerOrderId.ok) return sellerOrderId;
  const now = deps.clock.now();
  const done = await deps.unitOfWork.run<SellerOrderDetailView, FulfilmentFailure>(
    context.market,
    async () => {
      const record = await deps.orders.findForSeller(context.market, sellerId, sellerOrderId.value);
      if (record === null) return err({ code: 'ordering.seller-order-not-found' } as const);
      const delivered = markDelivered(record.sellerOrder, now);
      if (delivered === null) return err({ code: 'ordering.fulfilment-conflict' } as const);
      const saved = await deps.orders.saveFulfilment(
        context.market,
        delivered,
        record.sellerOrder.fulfilment,
      );
      return saved === 'saved'
        ? ok(sellerOrderDetailView({ ...record, sellerOrder: delivered }))
        : err({ code: 'ordering.fulfilment-conflict' } as const);
    },
  );
  return labelled(deps, context, done);
}

/** The step's answer with the names of its lines, read after the unit has closed. */
async function labelled(
  deps: OrderingDependencies,
  context: CallContext,
  result: Result<SellerOrderDetailView, FulfilmentFailure>,
): Promise<Result<LabelledSellerOrderDetailView, FulfilmentFailure>> {
  if (!result.ok) return result;
  const [one] = await labelSellerOrders(deps.labels, context, [result.value]);
  return ok(one!);
}

export interface ShipmentRecording {
  readonly recorded: number;
  /** Seller orders whose lines inventory refused or could not be reached for; tried again next run. */
  readonly failed: readonly { readonly sellerOrderId: string; readonly code: string }[];
}

/** The most seller orders one run takes, so a long outage does not become one long unit. */
const RECORD_BATCH = 20;

/**
 * The worker's side: tells inventory that the lines of each shipped seller order have left
 * (`recordShipment` is keyed by the order line, so a repeat is harmless), then marks the seller
 * order recorded. A refusal leaves the seller order unmarked for the next run.
 */
export async function recordShipments(
  deps: OrderingDependencies,
  context: CallContext,
): Promise<Result<ShipmentRecording, FulfilmentFailure>> {
  const pending = await deps.unitOfWork.run<
    Awaited<ReturnType<typeof deps.orders.findUnrecordedShipments>>,
    FulfilmentFailure
  >(
    context.market,
    async () => ok(await deps.orders.findUnrecordedShipments(context.market, RECORD_BATCH)),
    { readOnly: true },
  );
  if (!pending.ok) return pending;
  let recorded = 0;
  const failed: { sellerOrderId: string; code: string }[] = [];
  for (const record of pending.value) {
    let problem: string | null = null;
    for (const line of record.lines) {
      const done = await deps.inventory.recordShipment(context, { orderLineId: line.id });
      if (!done.ok) {
        problem = done.error.code;
        break;
      }
    }
    if (problem !== null) {
      failed.push({ sellerOrderId: record.sellerOrder.id, code: problem });
      continue;
    }
    const at = deps.clock.now();
    await deps.unitOfWork.run<true, FulfilmentFailure>(context.market, async () => {
      await deps.orders.markInventoryRecorded(context.market, record.sellerOrder.id, at);
      return ok(true as const);
    });
    recorded += 1;
  }
  return ok({ recorded, failed });
}
