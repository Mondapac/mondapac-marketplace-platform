import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import {
  LiveCheckFailed,
  TransferAlert,
} from '../../../platform/security-events/security-event-catalogue';
import type { PaymentsDependencies } from './payments-dependencies';

// The alerts of the transfer execution (package 6c). An alert is a security event of severity s2
// (ids and a code only), raised in the caller's unit when one is open and in a unit of its own
// otherwise; a failure to record one is logged and never changes the answer of the use case.

export type TransferAlertKind =
  | 'amount-out-of-range'
  | 'insufficient-platform-balance'
  | 'daily-total-over-threshold'
  | 'fence-breached'
  | 'partial-match'
  | 'hmac-key-missing'
  | 'transfer-unmatched';

const logger = new Logger('PaymentsTransfer');

/** The alert as a security event of this Market; for use inside an open read-write unit. */
export function recordTransferAlert(
  deps: PaymentsDependencies,
  context: CallContext,
  kind: TransferAlertKind,
  sellerId: string | null,
): Promise<void> {
  return deps.securityEvents.record(
    context,
    TransferAlert.event({ targetId: sellerId, payload: { kind } }),
  );
}

/** HP-1 condition 2 rule (iv): the key of a stored hash's version is missing; in the caller's unit. */
export const alertHmacKeyMissing = (
  deps: PaymentsDependencies,
  context: CallContext,
  sellerId: string,
): Promise<void> => recordTransferAlert(deps, context, 'hmac-key-missing', sellerId);

/** An alert raised outside any unit: a short unit of its own. */
export async function raiseTransferAlert(
  deps: PaymentsDependencies,
  context: CallContext,
  kind: TransferAlertKind,
  sellerId: string | null,
): Promise<void> {
  try {
    await deps.unitOfWork.run(context.market, async () => {
      await recordTransferAlert(deps, context, kind, sellerId);
      return ok(undefined);
    });
  } catch {
    logger.error({
      msg: 'payments.transfer.alert-failed',
      kind,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

/**
 * The live read of a connected account before a transfer failed. The counter behind
 * `payments_live_check_failures_total{market}`: the platform has no metrics registry yet, so each
 * failure is a security event `payments.live-check.failed` (counted per Market by the alert rule:
 * 5 in a trailing hour, or 3 in a row for one account) and a log line carrying the metric name.
 * Nothing else is written and no cooling-off starts: the control is "no transfer".
 */
export async function recordLiveCheckFailure(
  deps: PaymentsDependencies,
  context: CallContext,
  sellerId: string,
): Promise<void> {
  logger.warn({
    msg: 'payments_live_check_failures_total',
    marketId: context.market.marketId,
    sellerId,
    correlationId: context.correlationId,
  });
  try {
    await deps.unitOfWork.run(context.market, async () => {
      await deps.securityEvents.record(
        context,
        LiveCheckFailed.event({
          targetId: sellerId,
          payload: { reason: 'provider-unavailable' },
        }),
      );
      return ok(undefined);
    });
  } catch {
    logger.error({
      msg: 'payments.live-check.security-event-failed',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
