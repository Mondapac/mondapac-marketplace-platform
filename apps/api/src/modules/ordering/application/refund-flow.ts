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
import { RefundRequested, RefundSettled } from '../domain/audit';
import { RefundSucceeded } from '../domain/events';
import { isActingAsSession } from './acting-as';
import type { OrderingDependencies } from './checkout-flow';
import type { GatewayFailure, RefundAnswer } from './ports/checkout-gateway';

// Refunds of a paid seller order (tax step 3; ADR-0007 decision 11), asked for by an admin
// (`ordering.order.refund`). There is no seller refund path (ordering design 97; Hassan H1): a
// seller's own action never moves money while the seller ledger is not reversed. Built behind the Market switch `tax.refundCredit.enabled`, off: while it is off nothing is read,
// written or sent to Stripe. The amounts come from the values frozen on the order; `tax` works out
// the tax reversed. The refund is written (and the seller order's refunded sum raised) before
// Stripe is called with the stored key; then it settles: succeeded with a credit note, failed
// (the sum goes back down), or still pending when Stripe's answer is not final: the worker reads
// a refund Stripe made back by its id, and retries one Stripe never answered with the same key.
// The request and each outcome are audited (Hassan M3). Commission and the seller ledger are not touched yet (out of scope;
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
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAsSession(actor)) {
    return err({ code: 'access.denied' });
  }
  const orderId = parseIdField<'Order'>(input?.orderId, 'orderId');
  return refund(deps, context, input, orderId, { population: 'admin', accountId: actor.accountId });
}

async function refund(
  deps: OrderingDependencies,
  context: CallContext,
  input: RefundInput,
  orderId: Id<'Order'> | { readonly path: string; readonly code: string },
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
    ...(typeof orderId === 'string' ? [] : [orderId]),
    ...(typeof sellerOrderId === 'string' ? [] : [sellerOrderId]),
    ...(parsed.ok ? [] : parsed.fields),
  ];
  if (
    fields.length > 0 ||
    typeof sellerOrderId !== 'string' ||
    typeof orderId !== 'string' ||
    !parsed.ok
  ) {
    return err({ code: 'validation.failed', fields });
  }

  const read = await deps.unitOfWork.run<RefundTarget, RefundFailure>(
    context.market,
    async () => {
      const target = await deps.refunds.findTarget(context.market, sellerOrderId, orderId);
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
  const reserved = await deps.unitOfWork.run<true, RefundFailure>(context.market, async () => {
    if ((await deps.refunds.reserve(context.market, priced, target.refunded)) === 'stale') {
      return err({ code: 'conflict.retry' } as const);
    }
    await deps.audit.record(
      context,
      RefundRequested.entry(priced.id, {
        after: {
          sellerOrderId: priced.sellerOrderId,
          amount: money(priced.gross, priced.currency),
          tax: priced.tax === 0n ? null : money(priced.tax, priced.currency),
          reason: priced.reason,
          lineCount: priced.lines.length,
        },
      }),
    );
    return ok(true as const);
  });
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
 * One Stripe call for a pending refund, then its outcome in a unit of its own. A refund Stripe
 * already made is read back by its id; one it never answered is asked for again with its stored
 * key. Only Stripe's `succeeded` writes the credit note (Hassan M1); `failed` (or a refusal)
 * lowers the refunded sum; anything else keeps it pending (attempt counted, Stripe's id kept).
 * Settling twice is harmless: only a pending refund changes.
 */
async function settle(
  deps: OrderingDependencies,
  context: CallContext,
  refund: Refund,
  paymentIntentId: string,
): Promise<Settled> {
  const answer: Result<RefundAnswer, GatewayFailure> =
    refund.stripeRefundId === null
      ? await deps.gateway.refund({
          paymentIntentId,
          amount: refund.gross,
          orderId: refund.orderId,
          refundId: refund.id,
          marketId: context.market.marketId,
          idempotencyKey: refund.stripeIdempotencyKey,
        })
      : await deps.gateway.refundStatus(refund.stripeRefundId);
  const at = deps.clock.now();
  const stripeRefundId = answer.ok ? answer.value.refundId : refund.stripeRefundId;
  if (answer.ok && answer.value.status === 'succeeded') {
    const creditNoteId = deps.ids.next<'CreditNote'>();
    const done = await deps.unitOfWork.run<boolean, never>(context.market, async () => {
      const marked = await deps.refunds.markSucceeded(
        context.market,
        refund,
        answer.value.refundId,
        {
          id: creditNoteId,
          issuedAt: at,
        },
      );
      if (marked) {
        await deps.audit.record(
          context,
          RefundSettled.entry(refund.id, { after: { outcome: 'succeeded', creditNoteId } }),
        );
        await deps.outbox.append(context, [
          RefundSucceeded.record({
            aggregateId: refund.id,
            aggregateVersion: 1,
            occurredAt: at,
            payload: {
              orderId: refund.orderId,
              sellerOrderId: refund.sellerOrderId,
              refundId: refund.id,
            },
          }),
        ]);
      }
      return ok(marked);
    });
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
  // A refusal is final only on the first call of a refund Stripe never answered: after an
  // unknown answer Stripe may have made it, so a later refusal (a rotated key) keeps it pending
  // and never frees its units for a second refund (Hassan M1-R).
  const refused =
    !answer.ok &&
    isRejected(answer.error) &&
    refund.stripeRefundId === null &&
    refund.attempts === 0;
  if ((answer.ok && answer.value.status === 'failed') || refused) {
    const done = await deps.unitOfWork.run<boolean, never>(context.market, async () => {
      const marked = await deps.refunds.markFailed(context.market, refund, at, stripeRefundId);
      if (marked) {
        await deps.audit.record(
          context,
          RefundSettled.entry(refund.id, { after: { outcome: 'failed', creditNoteId: null } }),
        );
      }
      return ok(marked);
    });
    return done.ok && done.value
      ? {
          state: 'failed',
          refund: { ...refund, state: 'failed', stripeRefundId, settledAt: at },
          creditNoteId: null,
        }
      : { state: 'pending', refund, creditNoteId: null };
  }
  await deps.unitOfWork.run<true, never>(context.market, async () => {
    await deps.refunds.countAttempt(context.market, refund, answer.ok ? stripeRefundId : null);
    return ok(true as const);
  });
  return {
    state: 'pending',
    refund: { ...refund, stripeRefundId, attempts: refund.attempts + 1 },
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
/**
 * Stripe forgets an idempotency key after 24 hours: past that, a refund Stripe never answered is
 * not asked for again (it could refund twice). One Stripe made is read back by id at any age.
 */
const RETRY_WINDOW = Temporal.Duration.from({ hours: 23 });
/** The unknown answers after which a refund is reported as stuck (once, at exactly this count). */
export const REFUND_STUCK_ATTEMPTS = 10;

/**
 * The worker's side (`ordering.settle-refunds`): reads each pending refund Stripe made back by its
 * id, and retries one Stripe never answered with its stored key while Stripe still remembers the
 * key (asked for between 23 hours and a minute ago). An older unanswered one is never retried: it
 * stays pending for a person to check in the Stripe dashboard (an admin resolve use case is a
 * follow-up, Hassan L1), and is reported once when its attempts reach the threshold. Off: does
 * nothing.
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
