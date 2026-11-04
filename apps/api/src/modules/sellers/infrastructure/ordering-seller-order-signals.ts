import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { OrderingFacade } from '../../ordering';
import type {
  SellerOrderDayCount,
  SellerOrderSignals,
} from '../application/ports/seller-order-signals';
import { localDayBounds } from '../domain/seller-health-days';

/**
 * {@link SellerOrderSignals} on the ordering facade: paid, ready and late-ready seller orders of
 * the seller in each of the seller's local days, in one call, with the caller's context
 * unchanged. Any refusal throws so the rollup stores nothing for those days.
 */
export class OrderingFacadeSellerOrderSignals implements SellerOrderSignals {
  constructor(private readonly ordering: OrderingFacade) {}

  async days(
    context: CallContext,
    sellerId: Id<'Seller'>,
    days: readonly Temporal.PlainDate[],
    zone: string,
  ): Promise<readonly SellerOrderDayCount[]> {
    const windows = days.map((day) => localDayBounds(day, zone));
    const read = await this.ordering.sellerHealthCounts(context, sellerId, windows);
    if (!read.ok) throw new Error(`seller-health.orders: ${read.error.code}`);
    return read.value;
  }
}
