import type { Fulfilment } from './order';
import {
  LOSS_BEARERS,
  LOSS_REASON_CODES,
  type LossBearer,
  type LossReasonCode,
} from './reason-codes';
import {
  REFUND_REASONS,
  shippingGross,
  type RefundReason,
  type RefundRequest,
  type RefundTarget,
} from './refund';

// An admin cancels a paid order and gives all of it back (order detail decision 1, 31 Oct 2026):
// allowed only while no seller has started on it (every seller order still `to-ship` and not
// marked ready). The cancellation is a full refund of every seller order, built from the same
// frozen values as a refund by hand: every unit not yet refunded and the shipping not yet given
// back. The order itself stays `confirmed` (the ledger and the carrier steps follow refunds, not
// the status); a seller order whose every unit is refunded can no longer be marked ready.

/** A paid order's seller order as the cancellation checks it. */
export interface CancelPart {
  readonly target: RefundTarget;
  readonly fulfilment: Fulfilment;
  readonly ready: boolean;
}

export interface CancelRequest {
  readonly reason: RefundReason;
  readonly lossBearer: LossBearer;
  readonly lossReasonCode: LossReasonCode | null;
}

export type CancelRefusal =
  /** The order was never paid or the money was not captured. */
  | { readonly code: 'ordering.refund-not-allowed' }
  /** A seller has marked its part ready or it has left the shop: refund per seller instead. */
  | { readonly code: 'ordering.cancel-too-late' }
  /** A refund of a seller order is still waiting for Stripe. */
  | { readonly code: 'ordering.refund-in-progress' }
  /** Everything was refunded already. */
  | { readonly code: 'ordering.cancel-nothing-left' };

/** The body: a refund reason and who bears the loss (the seller by default). */
export function parseCancelRequest(input: {
  readonly reason: unknown;
  readonly lossBearer?: unknown;
  readonly lossReasonCode?: unknown;
}):
  | { readonly ok: true; readonly request: CancelRequest }
  | { readonly ok: false; readonly fields: readonly { path: string; code: string }[] } {
  const fields: { path: string; code: string }[] = [];
  const reason = input?.reason;
  if (!REFUND_REASONS.includes(reason as RefundReason)) {
    fields.push({ path: 'reason', code: 'value' });
  }
  let lossBearer: LossBearer = 'seller';
  const bearer = input?.lossBearer;
  if (bearer !== undefined && bearer !== null) {
    if (LOSS_BEARERS.includes(bearer as LossBearer)) lossBearer = bearer as LossBearer;
    else fields.push({ path: 'lossBearer', code: 'value' });
  }
  let lossReasonCode: LossReasonCode | null = null;
  const code = input?.lossReasonCode;
  const hasCode = code !== undefined && code !== null;
  const bearerValid = fields.every((f) => f.path !== 'lossBearer');
  if (lossBearer === 'platform' && !hasCode && bearerValid) {
    fields.push({ path: 'lossReasonCode', code: 'required' });
  } else if (hasCode && lossBearer === 'seller' && bearerValid) {
    fields.push({ path: 'lossReasonCode', code: 'unexpected' });
  } else if (hasCode && bearerValid) {
    if (LOSS_REASON_CODES.includes(code as LossReasonCode)) {
      lossReasonCode = code as LossReasonCode;
    } else fields.push({ path: 'lossReasonCode', code: 'value' });
  }
  return fields.length > 0
    ? { ok: false, fields }
    : {
        ok: true,
        request: { reason: reason as RefundReason, lossBearer, lossReasonCode },
      };
}

/** Whether a seller order may still be cancelled: nothing about it has started. */
export const notStarted = (part: Pick<CancelPart, 'fulfilment' | 'ready'>): boolean =>
  part.fulfilment === 'to-ship' && !part.ready;

/**
 * One refund request per seller order with something left to give back: every unit not refunded
 * by a refund that has not failed, and the rest of the shipping fee. Fails closed on anything a
 * person must look at first. A part fully refunded already is skipped.
 */
export function planCancel(
  parts: readonly CancelPart[],
  request: CancelRequest,
):
  | {
      readonly ok: true;
      readonly refunds: readonly {
        readonly target: RefundTarget;
        readonly request: RefundRequest;
      }[];
    }
  | { readonly ok: false; readonly error: CancelRefusal } {
  if (
    parts.length === 0 ||
    parts.some(
      ({ target }) =>
        target.orderStatus !== 'confirmed' ||
        target.paymentState !== 'captured' ||
        target.paymentIntentId === null,
    )
  ) {
    return { ok: false, error: { code: 'ordering.refund-not-allowed' } };
  }
  if (!parts.every(notStarted)) return { ok: false, error: { code: 'ordering.cancel-too-late' } };
  if (parts.some(({ target }) => target.pending)) {
    return { ok: false, error: { code: 'ordering.refund-in-progress' } };
  }
  const refunds = parts.flatMap(({ target }) => {
    const lines = target.lines.flatMap((line) => {
      const left = line.quantity - (target.refundedUnits.get(line.id) ?? 0);
      return left > 0 ? [{ orderLineId: line.id, quantity: left }] : [];
    });
    // An unknown shipping tax (an older order) leaves a fee that cannot be refunded on a guess:
    // the planning step refuses it with ordering.refund-tax-unknown.
    const gross = target.shipping === 0n ? 0n : (shippingGross(target) ?? target.shipping);
    const shipping = gross > target.refundedShipping ? gross - target.refundedShipping : 0n;
    if (lines.length === 0 && shipping === 0n) return [];
    return [{ target, request: { lines, shipping, ...request } }];
  });
  if (refunds.length === 0) return { ok: false, error: { code: 'ordering.cancel-nothing-left' } };
  return { ok: true, refunds };
}
