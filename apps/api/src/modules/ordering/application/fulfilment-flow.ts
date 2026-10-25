import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { OutboxWriteRefusedError } from '../../../platform/events/outbox-writer';
import { SellerOrderReady } from '../domain/events';
import { markDelivered, markReady, type Fulfilment } from '../domain/order';
import {
  sellerOrderDetailView,
  type LabelledSellerOrderPageView,
  type LabelledSellerOrderShipView,
  type SellerOrderCounts,
  type SellerOrderDetailView,
  type SellerOrderPageView,
} from '../domain/order-views';
import type { OrderingDependencies } from './checkout-flow';
import { labelSellerOrders } from './order-labels';
import type { SellerOrderPage, SellerOrderRecord } from './ports/order.repository';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, openShipTo } from './read-flow';

// The seller's side of an order once it is paid: see it and tell the platform it is ready; the
// platform books the delivery, the seller never delivers or names a carrier. The delivery is
// recorded from the carrier's progress (or, until pickup codes exist, by the seller marking it
// delivered). The seller sees only the seller orders of its own shop. Inventory learns of a shipment
// from the worker (`recordShipments`), not from the seller's request. One seller order's page
// (view, ship, deliver) carries the delivery address copied at checkout; the list does not.

const logger = new Logger('OrderingFulfilmentFlow');

/** A seller order's detail and the sealed address it is shipped to, read in one unit. */
interface Detailed {
  readonly view: SellerOrderDetailView;
  readonly record: Pick<SellerOrderRecord, 'accountId' | 'shipToSealed'>;
}

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
): Promise<Result<LabelledSellerOrderShipView, FulfilmentFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const sellerOrderId = parseSellerOrderId(input?.sellerOrderId);
  if (!sellerOrderId.ok) return sellerOrderId;
  return labelled(
    deps,
    context,
    await deps.unitOfWork.run<Detailed, FulfilmentFailure>(
      context.market,
      async () => {
        const record = await deps.orders.findForSeller(
          context.market,
          sellerId,
          sellerOrderId.value,
        );
        return record === null
          ? err({ code: 'ordering.seller-order-not-found' } as const)
          : ok({ view: sellerOrderDetailView(record), record });
      },
      { readOnly: true },
    ),
  );
}

/**
 * The seller tells the platform that a paid seller order is ready. That is all the seller does:
 * it picks no delivery method and no provider and never delivers (owner decision). The buyer's
 * method and the fleet decide what happens next, in the subscriber of `SellerOrderReady`:
 * instant and same-day orders are booked with a carrier, a pickup waits for the buyer, a
 * scheduled order was booked at payment. Ownership: only the session's own seller orders are
 * found (another shop's id answers exactly as an unknown one). Idempotent: a repeat answers the
 * current state and writes no second event.
 */
export async function markSellerOrderReady(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<LabelledSellerOrderShipView, FulfilmentFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const sellerOrderId = parseSellerOrderId(input?.sellerOrderId);
  if (!sellerOrderId.ok) return sellerOrderId;
  const now = deps.clock.now();
  let outcome = 'ready';
  const done = await deps.unitOfWork.run<Detailed, FulfilmentFailure>(context.market, async () => {
    const record = await deps.orders.findForSeller(context.market, sellerId, sellerOrderId.value);
    if (record === null) {
      outcome = 'ordering.seller-order-not-found';
      return err({ code: 'ordering.seller-order-not-found' } as const);
    }
    const already = (current: SellerOrderRecord) => {
      outcome = 'already-ready';
      return ok({ view: sellerOrderDetailView(current), record: current });
    };
    if (record.sellerOrder.readyAt !== null) return already(record);
    const ready = markReady(record.sellerOrder, now);
    if (ready === null) {
      outcome = 'ordering.fulfilment-conflict';
      return err({ code: 'ordering.fulfilment-conflict' } as const);
    }
    if ((await deps.orders.saveReady(context.market, ready)) !== 'saved') {
      // A second tab won the race: if it said ready, this is a repeat, else the order moved on.
      const fresh = await deps.orders.findForSeller(context.market, sellerId, sellerOrderId.value);
      if (fresh !== null && fresh.sellerOrder.readyAt !== null) return already(fresh);
      outcome = 'ordering.fulfilment-conflict';
      return err({ code: 'ordering.fulfilment-conflict' } as const);
    }
    // Written with the ready time, once per seller order (a repeat finds it ready). A refused
    // event rolls the change back: the seller sees a conflict and tries again.
    try {
      await deps.outbox.append(context, [
        SellerOrderReady.record({
          aggregateId: ready.id,
          aggregateVersion: 1,
          occurredAt: now,
          payload: {
            orderId: record.orderId,
            sellerOrderId: ready.id,
            sellerId: ready.sellerId,
          },
        }),
      ]);
    } catch (error) {
      if (error instanceof OutboxWriteRefusedError) {
        outcome = 'ordering.fulfilment-conflict';
        return err({ code: 'ordering.fulfilment-conflict' } as const);
      }
      throw error;
    }
    return ok({ view: sellerOrderDetailView({ ...record, sellerOrder: ready }), record });
  });
  logger.log({
    msg: 'ordering.seller-order-ready',
    outcome,
    sellerOrderId: sellerOrderId.value,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return labelled(deps, context, done);
}

/** Records the delivery of a shipped seller order. */
export async function deliverSellerOrder(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<LabelledSellerOrderShipView, FulfilmentFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const sellerOrderId = parseSellerOrderId(input?.sellerOrderId);
  if (!sellerOrderId.ok) return sellerOrderId;
  const now = deps.clock.now();
  const done = await deps.unitOfWork.run<Detailed, FulfilmentFailure>(context.market, async () => {
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
      ? ok({ view: sellerOrderDetailView({ ...record, sellerOrder: delivered }), record })
      : err({ code: 'ordering.fulfilment-conflict' } as const);
  });
  return labelled(deps, context, done);
}

/**
 * The step's answer with the names of its lines and the opened delivery address, read after the
 * unit has closed.
 */
async function labelled(
  deps: OrderingDependencies,
  context: CallContext,
  result: Result<Detailed, FulfilmentFailure>,
): Promise<Result<LabelledSellerOrderShipView, FulfilmentFailure>> {
  if (!result.ok) return result;
  const { view, record } = result.value;
  const [one] = await labelSellerOrders(deps.labels, context, [view]);
  return ok({
    ...one!,
    shipTo: await openShipTo(deps, context, record.accountId, record.shipToSealed),
  });
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
