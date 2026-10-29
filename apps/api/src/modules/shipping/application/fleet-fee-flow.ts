import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { parseFleetFeeReport } from '../domain/fleet-fee';
import type { ShippingDependencies } from './shipping-dependencies';

// The fleet-fee ledger (delivery models, package 5): what a fleet charges the PLATFORM for a
// delivery (a cancellation, a courier kept waiting, a parcel returned). The buyer is never charged
// these. A fleet adapter that learns of a fee (from a webhook or an invoice line) reports it here,
// with a reason code; a report is recorded once by the fleet's own id of the fee.

const logger = new Logger('ShippingFleetFeeFlow');

export type RecordFleetFeeFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** The fleet holds no booking of this seller order (yet): the adapter reports again later. */
  | { readonly code: 'shipping.carrier-delivery-not-found' }
  | { readonly code: 'shipping.unavailable' };

/** What `recordFleetFee` did: `recorded` now, or `duplicate` (the fee was recorded before). */
export type RecordFleetFeeOutcome = 'recorded' | 'duplicate';

/**
 * `record-fleet-fee`: stores one fee a fleet reports for a seller order it booked. The seller order
 * must have a booking with that fleet (a report cannot invent a delivery), the amount must be above
 * zero in the Market currency, and a repeat of the same fleet and reference records nothing.
 */
export async function recordFleetFee(
  deps: ShippingDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<RecordFleetFeeOutcome, RecordFleetFeeFailure>> {
  const { market } = context;
  const report = parseFleetFeeReport(input, deps.policy.currency(market));
  if (!report.ok) return err({ code: 'validation.failed', fields: report.error });
  const fee = report.value;
  const sellerOrderId = fee.sellerOrderId as Id<'SellerOrder'>;
  const recordedAt = deps.clock.now();
  const id = deps.ids.next<'FleetFee'>();
  const stored = await deps.unitOfWork.run<RecordFleetFeeOutcome, RecordFleetFeeFailure>(
    market,
    async () => {
      const booking = await deps.bookings.findBySellerOrder(market, sellerOrderId);
      if (booking === null || booking.fleet !== fee.fleet) {
        return err({ code: 'shipping.carrier-delivery-not-found' });
      }
      const result = await deps.ledger.recordFee(market, {
        id,
        fleet: fee.fleet,
        sellerOrderId,
        reason: fee.reason,
        amount: fee.amount,
        externalRef: fee.externalRef,
        occurredAt: fee.occurredAt,
        recordedAt,
      });
      return ok(result);
    },
  );
  logger.log({
    msg: 'shipping.fleet-fee',
    outcome: stored.ok ? stored.value : stored.error.code,
    fleet: fee.fleet,
    reason: fee.reason,
    sellerOrderId,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return stored;
}
