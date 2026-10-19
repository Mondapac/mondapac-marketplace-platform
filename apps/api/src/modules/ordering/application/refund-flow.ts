import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import {
  parseRefundRequest,
  planRefund,
  priceRefund,
  type Refund,
  type RefundReason,
  type RefundRefusal,
  type RefundState,
  type RefundTarget,
} from '../domain/refund';
import type { OrderingDependencies } from './checkout-flow';
import type { GatewayFailure } from './ports/checkout-gateway';

// Refunds of a paid seller order (tax step 3; ADR-0007 decision 11), asked for by an admin
// (`ordering.order.refund`) or by the seller of that seller order (`ordering.seller-order.refund`).
// Built behind the Market switch `tax.refundCredit.enabled`, off: while it is off nothing is read,
// written or sent to Stripe. The amounts come from the values frozen on the order; `tax` works out
// the tax reversed. The refund is written (and the seller order's refunded sum raised) before
// Stripe is called with the stored key; then it settles: succeeded with a credit note, failed
// (the sum goes back down), or still pending when Stripe's answer is unknown, for the worker to
// retry with the same key. Commission and the seller ledger are not touched yet (out of scope;
// GST on commission waits for the tax agent, Q1).

export type RefundFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** The Market switch `tax.refundCredit.enabled` is off. */
  | { readonly code: 'ordering.refund-disabled' }
  | { readonly code: 'ordering.seller-order-not-found' }
  | RefundRefusal
  /** Another refund of the seller order was written meanwhile: read again and retry. */
  | { readonly code: 'conflict.retry' }
  /** `tax` could not work out the tax reversed: nothing was written. */
  | { readonly code: 'ordering.refund-tax-unavailable' }
  /** Stripe refused the refund: it is recorded as failed and nothing went back. */
  | { readonly code: 'ordering.refund-rejected' };

export interface RefundLineView {
  readonly orderLineId: Id<'OrderLine'>;
  readonly quantity: number;
  readonly amount: Money;
  readonly tax: Money;
  readonly taxRateBps: number;
  readonly taxInclusive: boolean;
}

/** One refund as the panels show it: ids, codes, money and instants. */
export interface RefundView {
  readonly refundId: Id<'Refund'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  /** `pending` while Stripe's answer is unknown: the worker retries it. */
  readonly state: RefundState;
  readonly reason: RefundReason;
  readonly amount: Money;
  readonly tax: Money;
  readonly shipping: { readonly amount: Money; readonly tax: Money } | null;
  readonly lines: readonly RefundLineView[];
  readonly requestedAt: Temporal.Instant;
  readonly settledAt: Temporal.Instant | null;
  /** The credit note written when the refund succeeded; null otherwise. */
  readonly creditNoteId: Id<'CreditNote'> | null;
}

export function refundView(refund: Refund, creditNoteId: Id<'CreditNote'> | null): RefundView {
  const m = (amount: bigint) => money(amount, refund.currency);
  return {
    refundId: refund.id,
    orderId: refund.orderId,
    sellerOrderId: refund.sellerOrderId,
    state: refund.state,
    reason: refund.reason,
    amount: m(refund.gross),
    tax: m(refund.tax),
    shipping:
      refund.shipping === null
        ? null
        : { amount: m(refund.shipping.gross), tax: m(refund.shipping.tax) },
    lines: refund.lines.map((line) => ({
      orderLineId: line.orderLineId,
      quantity: line.quantity,
      amount: m(line.gross),
      tax: m(line.tax),
      taxRateBps: line.taxRateBps,
      taxInclusive: line.taxInclusive,
    })),
    requestedAt: refund.requestedAt,
    settledAt: refund.settledAt,
    creditNoteId,
  };
}

export interface RefundInput {
  readonly sellerOrderId: unknown;
  readonly lines: unknown;
  readonly shippingAmount: unknown;
  readonly reason: unknown;
}

const parseIdField = <T extends string>(value: unknown, path: string) => {
  const parsed = typeof value === 'string' ? parseId<T>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : { path, code: 'format' };
};

/** An admin refunds part or all of one seller order of an order of the Market. */
export async function adminRefund(
  deps: OrderingDependencies,
  context: CallContext,
  input: RefundInput & { readonly orderId: unknown },
): Promise<Result<RefundView, RefundFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const orderId = parseIdField<'Order'>(input?.orderId, 'orderId');
  return refund(deps, context, input, typeof orderId === 'string' ? { orderId } : orderId, {
    population: 'admin',
    accountId: actor.accountId,
  });
}

/** The seller refunds part or all of one of its own paid seller orders. */
export async function sellerRefund(
  deps: OrderingDependencies,
  context: CallContext,
  input: RefundInput,
): Promise<Result<RefundView, RefundFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') {
    return err({ code: 'access.denied' });
  }
  const sellerId = parseIdField<'Seller'>(actor.sellerId, 'sellerId');
  if (typeof sellerId !== 'string') return err({ code: 'access.denied' });
  return refund(
    deps,
    context,
    input,
    { sellerId },
    {
      population: 'seller',
      accountId: actor.accountId,
    },
  );
}

async function refund(
  deps: OrderingDependencies,
  context: CallContext,
  input: RefundInput,
  owner:
    | { readonly sellerId: Id<'Seller'> }
    | { readonly orderId: Id<'Order'> }
    | { readonly path: string; readonly code: string },
  actor: Refund['actor'],
): Promise<Result<RefundView, RefundFailure>> {
  // Off: nothing is read, written or sent (fail closed).
  if (!deps.policy.refundsEnabled(context.market)) return err({ code: 'ordering.refund-disabled' });
  const sellerOrderId = parseIdField<'SellerOrder'>(input?.sellerOrderId, 'sellerOrderId');
  const parsed = parseRefundRequest({
    lines: input?.lines,
    shippingAmount: input?.shippingAmount,
    reason: input?.reason,
  });
  const fields = [
    ...('path' in owner ? [owner] : []),
    ...(typeof sellerOrderId === 'string' ? [] : [sellerOrderId]),
    ...(parsed.ok ? [] : parsed.fields),
  ];
  if (fields.length > 0 || typeof sellerOrderId !== 'string' || !parsed.ok || 'path' in owner) {
    return err({ code: 'validation.failed', fields });
  }

  const read = await deps.unitOfWork.run<RefundTarget, RefundFailure>(
    context.market,
    async () => {
      const target = await deps.refunds.findTarget(context.market, sellerOrderId, owner);
      return target === null
        ? err({ code: 'ordering.seller-order-not-found' } as const)
        : ok(target);
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const target = read.value;
  const planned = planRefund(target, parsed.request);
  if (!planned.ok) return err(planned.error);
  const { plan } = planned;

  const reversed = await deps.tax.reverseRefundTax(context, {
    lines: plan.lines.map(({ line, unitsBefore, units }) => ({
      tax: line.taxAmount!,
      quantity: line.quantity,
      unitsBefore,
      units,
    })),
    charges: plan.shipping === null ? [] : [plan.shipping],
  });
  if (!reversed.ok) return err({ code: 'ordering.refund-tax-unavailable' });

  const refundId = deps.ids.next<'Refund'>();
  const priced = priceRefund(target, plan, reversed.value, {
    id: refundId,
    reason: parsed.request.reason,
    actor,
    stripeIdempotencyKey: `refund-${refundId}`,
    requestedAt: deps.clock.now(),
  });
  if (priced === null) {
    return err({ code: 'ordering.refund-exceeds', fields: [{ path: 'lines', code: 'exceeds' }] });
  }

  // The refund and the raised sum are written before Stripe is called: a crash after the call
  // leaves a pending refund the worker retries with the same key, never a second refund.
  const reserved = await deps.unitOfWork.run<true, RefundFailure>(context.market, async () =>
    (await deps.refunds.reserve(context.market, priced, target.refunded)) === 'saved'
      ? ok(true as const)
      : err({ code: 'conflict.retry' } as const),
  );
  if (!reserved.ok) return reserved;

  const settled = await settle(deps, context, priced, target.paymentIntentId!);
  if (settled.state === 'failed') return err({ code: 'ordering.refund-rejected' });
  return ok(refundView(settled.refund, settled.creditNoteId));
}

interface Settled {
  readonly state: RefundState;
  readonly refund: Refund;
  readonly creditNoteId: Id<'CreditNote'> | null;
}

/**
 * One Stripe call for a pending refund, then its outcome in a unit of its own: succeeded with its
 * credit note, failed with the refunded sum lowered, or still pending (attempt counted) when
 * nothing is known. Settling twice is harmless: only a pending refund changes.
 */
async function settle(
  deps: OrderingDependencies,
  context: CallContext,
  refund: Refund,
  paymentIntentId: string,
): Promise<Settled> {
  const answer = await deps.gateway.refund({
    paymentIntentId,
    amount: refund.gross,
    orderId: refund.orderId,
    refundId: refund.id,
    marketId: context.market.marketId,
    idempotencyKey: refund.stripeIdempotencyKey,
  });
  const at = deps.clock.now();
  if (answer.ok) {
    const creditNoteId = deps.ids.next<'CreditNote'>();
    const done = await deps.unitOfWork.run<boolean, never>(context.market, async () =>
      ok(
        await deps.refunds.markSucceeded(context.market, refund, answer.value.refundId, {
          id: creditNoteId,
          issuedAt: at,
        }),
      ),
    );
    return done.ok && done.value
      ? {
          state: 'succeeded',
          refund: {
            ...refund,
            state: 'succeeded',
            stripeRefundId: answer.value.refundId,
            settledAt: at,
          },
          creditNoteId,
        }
      : { state: 'pending', refund, creditNoteId: null };
  }
  if (isRejected(answer.error)) {
    await deps.unitOfWork.run<boolean, never>(context.market, async () =>
      ok(await deps.refunds.markFailed(context.market, refund, at)),
    );
    return {
      state: 'failed',
      refund: { ...refund, state: 'failed', settledAt: at },
      creditNoteId: null,
    };
  }
  await deps.unitOfWork.run<true, never>(context.market, async () => {
    await deps.refunds.countAttempt(context.market, refund.id);
    return ok(true as const);
  });
  return {
    state: 'pending',
    refund: { ...refund, attempts: refund.attempts + 1 },
    creditNoteId: null,
  };
}

const isRejected = (failure: GatewayFailure): boolean =>
  failure.code === 'payment.provider-rejected';

export interface RefundSettling {
  readonly succeeded: number;
  readonly failed: number;
  /** Refunds whose unknown answers just reached the threshold: ids and count only. */
  readonly stuck: readonly { readonly refundId: string; readonly attempts: number }[];
}

const SETTLE_BATCH = 20;
/** A refund younger than this may still be in its own request's call. */
const SETTLE_AFTER = Temporal.Duration.from({ minutes: 1 });
/** Stripe forgets an idempotency key after 24 hours: past that a retry could refund twice. */
const RETRY_WINDOW = Temporal.Duration.from({ hours: 23 });
/** The unknown answers after which a refund is reported as stuck (once, at exactly this count). */
export const REFUND_STUCK_ATTEMPTS = 10;

/**
 * The worker's side (`ordering.settle-refunds`): retries each pending refund with its stored key
 * while Stripe still remembers the key (asked for between 23 hours and a minute ago). An older one
 * is never retried: it stays pending for a person to check in the Stripe dashboard, and is
 * reported once when its unknown answers reach the threshold. Off: does nothing.
 */
export async function settleRefunds(
  deps: OrderingDependencies,
  context: CallContext,
): Promise<Result<RefundSettling, never>> {
  const none: RefundSettling = { succeeded: 0, failed: 0, stuck: [] };
  if (!deps.policy.refundsEnabled(context.market)) return ok(none);
  const now = deps.clock.now();
  const pending = await deps.unitOfWork.run<
    Awaited<ReturnType<typeof deps.refunds.findPending>>,
    never
  >(
    context.market,
    async () =>
      ok(
        await deps.refunds.findPending(
          context.market,
          { after: now.subtract(RETRY_WINDOW), before: now.subtract(SETTLE_AFTER) },
          SETTLE_BATCH,
        ),
      ),
    { readOnly: true },
  );
  if (!pending.ok) return ok(none);
  let succeeded = 0;
  let failed = 0;
  const stuck: { refundId: string; attempts: number }[] = [];
  for (const { refund, paymentIntentId } of pending.value) {
    const settled = await settle(deps, context, refund, paymentIntentId);
    if (settled.state === 'succeeded') succeeded += 1;
    if (settled.state === 'failed') failed += 1;
    if (settled.state === 'pending' && settled.refund.attempts === REFUND_STUCK_ATTEMPTS) {
      stuck.push({ refundId: refund.id, attempts: settled.refund.attempts });
    }
  }
  return ok({ succeeded, failed, stuck });
}
