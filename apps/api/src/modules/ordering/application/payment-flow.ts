import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, PendingEvent, Result } from '@mondapac/shared-kernel';
import { cancelOrder, confirmOrder, type OrderState, type PaymentState } from '../domain/order';
import type { AuthorisedPayment, PaymentFailure } from '../contracts';
import { OrderPaid } from '../domain/events';
import type { OrderingDependencies } from './checkout-flow';

// The internal path package 2 (the Stripe webhook receiver) calls, as the system actor, after it
// has verified the event and re-read the object from Stripe. Both operations are idempotent: a
// repeated delivery finds the order already settled and changes nothing.

export type ConfirmOutcome =
  /** Stock committed, money captured, order confirmed. */
  | 'confirmed'
  /** The order was already confirmed: nothing changed. */
  | 'already-confirmed'
  /** The order could not be fulfilled (cancelled, stock gone, amount differs): the hold was released. */
  | 'voided';

const COMMIT_ATTEMPTS = 3;
const RETRY: Result<never, PaymentFailure> = err({ code: 'ordering.try-again' });

const isoId = (value: unknown): Id<'Order'> | null => {
  const parsed = typeof value === 'string' ? parseId<'Order'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

/** Reads the order, then writes one change under its version; a stale write asks for a retry. */
async function update(
  deps: OrderingDependencies,
  context: CallContext,
  orderId: Id<'Order'>,
  change: (order: OrderState) => OrderState | null,
  /** Events to write to the outbox, in the same unit, once the change is saved. */
  events?: (saved: OrderState) => readonly PendingEvent[],
): Promise<Result<OrderState | null, PaymentFailure>> {
  return deps.unitOfWork.run<OrderState | null, PaymentFailure>(context.market, async () => {
    const order = await deps.orders.findById(context.market, orderId);
    if (order === null) return err({ code: 'ordering.order-not-found' } as const);
    const next = change(order);
    if (next === null) return ok(null);
    const saved = await deps.orders.save(context.market, next);
    if (saved !== 'saved') return RETRY;
    const written = { ...next, version: next.version + 1 };
    if (events !== undefined) await deps.outbox.append(context, events(written));
    return ok(written);
  });
}

/** Voids the authorisation. A provider that cannot be reached asks the caller to retry. */
async function voidMoney(
  deps: OrderingDependencies,
  order: OrderState,
  paymentIntentId: string,
): Promise<boolean> {
  const done = await deps.gateway.voidAuthorisation(paymentIntentId, `void-${paymentIntentId}`);
  return done.ok;
}

/**
 * `confirm-payment`: the card holds the money (authorised). Stock first, money second:
 * 1. an order that is not pending, or whose amount differs, is voided, never captured;
 * 2. the inventory reservation is committed (the stock is now ordered);
 * 3. only then is the money captured, with a key derived from the order;
 * 4. the order is confirmed and the cart lines are cleared.
 * If the stock cannot be committed the authorisation is voided and the order cancelled; if the
 * capture is refused the commit is undone line by line.
 */
export async function confirmPayment(
  deps: OrderingDependencies,
  context: CallContext,
  input: AuthorisedPayment,
): Promise<Result<ConfirmOutcome, PaymentFailure>> {
  const orderId = isoId(input?.orderId);
  if (
    orderId === null ||
    typeof input.paymentIntentId !== 'string' ||
    input.paymentIntentId.length === 0 ||
    input.paymentIntentId.length > 255 ||
    typeof input.sessionId !== 'string' ||
    input.sessionId.length === 0
  ) {
    return err({ code: 'validation.failed' });
  }
  const loaded = await deps.unitOfWork.run<OrderState, PaymentFailure>(
    context.market,
    async () => {
      const found = await deps.orders.findById(context.market, orderId);
      return found === null ? err({ code: 'ordering.order-not-found' } as const) : ok(found);
    },
    { readOnly: true },
  );
  if (!loaded.ok) return loaded;
  const order = loaded.value;
  // The payment must come from this order's own Checkout session, not another order's.
  if (order.stripeSessionId === null || order.stripeSessionId !== input.sessionId) {
    return err({ code: 'validation.failed' });
  }

  if (order.status === 'confirmed') {
    // A second payment for an order that is already paid: release it, keep the first.
    if (order.stripePaymentIntentId === input.paymentIntentId) return ok('already-confirmed');
    return (await voidMoney(deps, order, input.paymentIntentId)) ? ok('voided') : RETRY;
  }
  const wrongAmount =
    input.amount?.currency !== order.total.currency || input.amount?.amount !== order.total.amount;
  if (order.status === 'cancelled' || wrongAmount) {
    if (!(await voidMoney(deps, order, input.paymentIntentId))) return RETRY;
    // A pending order is released only while no other payment is authorised on it.
    if (order.status === 'pending-payment' && order.paymentState !== 'none') return ok('voided');
    const settled =
      order.status === 'pending-payment'
        ? await release(deps, context, order, 'payment-failed', 'voided')
        : await update(deps, context, orderId, (o) =>
            o.stripePaymentIntentId === null
              ? { ...o, paymentState: 'voided', stripePaymentIntentId: input.paymentIntentId }
              : null,
          );
    return settled.ok ? ok('voided') : settled;
  }

  // Pending: remember the authorisation before anything else happens.
  const marked = await update(deps, context, orderId, (o) =>
    o.status === 'pending-payment' && o.paymentState === 'none'
      ? { ...o, paymentState: 'authorised', stripePaymentIntentId: input.paymentIntentId }
      : null,
  );
  if (!marked.ok) return marked;
  const authorised = marked.value ?? (await reload(deps, context, orderId));
  if (authorised === null) return err({ code: 'ordering.order-not-found' });
  if (authorised.stripePaymentIntentId !== input.paymentIntentId) {
    // Another payment already won this order.
    return (await voidMoney(deps, authorised, input.paymentIntentId)) ? ok('voided') : RETRY;
  }
  if (authorised.status !== 'pending-payment') return ok('already-confirmed');

  const commitRequest = {
    reservationId: authorised.reservationId,
    checkoutRef: authorised.id,
    lines: authorised.lines.map((line) => ({
      reservationLineId: line.reservationLineId,
      orderLineId: line.id,
    })),
  };
  let committed = await deps.inventory.commitReservation(context, commitRequest);
  for (let attempt = 1; attempt < COMMIT_ATTEMPTS; attempt += 1) {
    if (committed.ok || committed.error.code !== 'conflict.retry') break;
    committed = await deps.inventory.commitReservation(context, commitRequest);
  }
  if (!committed.ok) {
    if (committed.error.code === 'conflict.retry' || committed.error.code === 'access.denied') {
      return RETRY;
    }
    // Insufficient, released for good, unknown or mismatched: the stock cannot be had.
    if (!(await voidMoney(deps, authorised, input.paymentIntentId))) return RETRY;
    const settled = await release(deps, context, authorised, 'stock-unavailable', 'voided');
    return settled.ok ? ok('voided') : settled;
  }

  const captured = await deps.gateway.capture(input.paymentIntentId, `capture-${authorised.id}`);
  if (!captured.ok) {
    if (captured.error.code === 'payment.provider-unavailable') return RETRY;
    // Refused for good (for example the authorisation lapsed): give the stock back.
    for (const line of authorised.lines) {
      await deps.inventory.cancelCommittedLine(context, { orderLineId: line.id });
    }
    const settled = await update(deps, context, orderId, (o) =>
      cancelOrder(o, 'payment-failed', 'voided', deps.clock.now()),
    );
    return settled.ok ? ok('voided') : settled;
  }

  const confirmed = await update(
    deps,
    context,
    orderId,
    (o) => confirmOrder(o, deps.clock.now()),
    // Written with the confirmation, so a paid order always has its event (and only once: a
    // repeat finds the order confirmed and changes nothing).
    (paid) => [
      OrderPaid.record({
        aggregateId: paid.id,
        aggregateVersion: paid.version,
        occurredAt: deps.clock.now(),
        payload: {
          orderId: paid.id,
          sellerOrderIds: paid.sellerOrders.map((sellerOrder) => sellerOrder.id),
          sellerIds: paid.sellerOrders.map((sellerOrder) => sellerOrder.sellerId),
        },
      }),
    ],
  );
  if (!confirmed.ok) {
    // The money is taken and the stock is ordered; the retry finds the order pending and
    // repeats the (idempotent) commit and capture before it confirms.
    return confirmed;
  }
  // The money is taken but the order is no longer pending: never answer 'confirmed' for it.
  // The retry finds it cancelled, tries to void the intent, and fails loudly for an admin.
  if (confirmed.value === null) return RETRY;
  await deps.cart.clearOrdered(context, {
    accountId: authorised.accountId,
    units: authorised.lines.map(({ offerId, variantId }) => ({ offerId, variantId })),
  });
  return ok('confirmed');
}

async function reload(
  deps: OrderingDependencies,
  context: CallContext,
  orderId: Id<'Order'>,
): Promise<OrderState | null> {
  const read = await deps.unitOfWork.run<OrderState | null, never>(
    context.market,
    async () => ok(await deps.orders.findById(context.market, orderId)),
    { readOnly: true },
  );
  return read.ok ? read.value : null;
}

/** Releases the stock hold and cancels a pending order. */
async function release(
  deps: OrderingDependencies,
  context: CallContext,
  order: OrderState,
  reason: 'expired' | 'payment-failed' | 'stock-unavailable',
  paymentState: PaymentState,
): Promise<Result<OrderState | null, PaymentFailure>> {
  // A reservation already gone (expired, superseded) answers not-found: nothing left to release.
  const released = await deps.inventory.releaseReservation(context, {
    reservationId: order.reservationId,
    cause: reason === 'payment-failed' ? 'payment-failed' : 'cancelled',
  });
  // Committed meanwhile: a confirm is in progress, so this cancel must not win.
  if (!released.ok && released.error.code === 'inventory.reservation.committed') return RETRY;
  const settled = await update(deps, context, order.id, (o) =>
    cancelOrder(o, reason, paymentState === 'voided' ? 'voided' : o.paymentState, deps.clock.now()),
  );
  if (!settled.ok || settled.value !== null) return settled;
  // Nothing changed: either it was settled meanwhile, or a payment was authorised on it.
  const now = await reload(deps, context, order.id);
  return now !== null && now.status === 'pending-payment' ? RETRY : settled;
}

export type CancelOutcome = 'cancelled' | 'ignored';

/**
 * `cancel-payment`: the Checkout session expired or the payment failed. A pending order is
 * cancelled and its stock hold released (an authorisation still on the card is voided first). An
 * order that is already settled is left alone.
 */
export async function cancelPayment(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly orderId: string; readonly cause: 'expired' | 'payment-failed' },
): Promise<Result<CancelOutcome, PaymentFailure>> {
  const orderId = isoId(input?.orderId);
  if (orderId === null || (input.cause !== 'expired' && input.cause !== 'payment-failed')) {
    return err({ code: 'validation.failed' });
  }
  const order = await reload(deps, context, orderId);
  if (order === null) return err({ code: 'ordering.order-not-found' });
  if (order.status !== 'pending-payment') return ok('ignored');
  let paymentState: PaymentState = order.paymentState;
  if (order.paymentState === 'authorised' && order.stripePaymentIntentId !== null) {
    if (!(await voidMoney(deps, order, order.stripePaymentIntentId))) return RETRY;
    paymentState = 'voided';
  }
  const settled = await release(deps, context, order, input.cause, paymentState);
  return settled.ok ? ok('cancelled') : settled;
}
