import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { CommissionPayoutsFacade } from '../../commission-payouts';
import type {
  SellerDisputeDayCount,
  SellerDisputeSignals,
} from '../application/ports/seller-dispute-signals';
import { localDayBounds } from '../domain/seller-health-days';

/**
 * {@link SellerDisputeSignals} on the commission-payouts facade: the disputes the seller lost in
 * each of the seller's local days, in one call, with the caller's context unchanged. Any refusal
 * throws so the rollup stores nothing for those days.
 */
export class CommissionPayoutsSellerDisputeSignals implements SellerDisputeSignals {
  constructor(private readonly commissionPayouts: CommissionPayoutsFacade) {}

  async days(
    context: CallContext,
    sellerId: Id<'Seller'>,
    days: readonly Temporal.PlainDate[],
    zone: string,
  ): Promise<readonly SellerDisputeDayCount[]> {
    const windows = days.map((day) => localDayBounds(day, zone));
    const read = await this.commissionPayouts.sellerLostDisputes(context, sellerId, windows);
    if (!read.ok) throw new Error(`seller-health.disputes: ${read.error.code}`);
    return read.value;
  }
}
