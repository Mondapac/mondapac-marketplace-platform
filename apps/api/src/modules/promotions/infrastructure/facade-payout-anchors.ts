import type { CommissionPayoutsFacade } from '../../commission-payouts';
import type { PayoutAnchors } from '../application/ports/payout-anchors';

/** {@link PayoutAnchors} on `commission-payouts`' facade (system actor only; failures are unknown). */
export class FacadePayoutAnchors implements PayoutAnchors {
  constructor(private readonly commission: CommissionPayoutsFacade) {}

  async anchorOf(
    ...[context, sellerOrderId]: Parameters<PayoutAnchors['anchorOf']>
  ): ReturnType<PayoutAnchors['anchorOf']> {
    if (context.actor.kind !== 'system') return { known: false };
    const read = await this.commission
      .sellerOrderPayoutAnchor(context, sellerOrderId)
      .catch(() => ({ ok: false }) as const);
    if (!read.ok) return { known: false };
    return {
      known: true,
      value: { sellerId: read.value.sellerId, eligibleAt: read.value.eligibleAt },
    };
  }
}
