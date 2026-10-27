import type { CallContext } from '@mondapac/shared-kernel';
import type {
  DisputeSource,
  OrderPaymentAnswer,
  OrderPaymentLookup,
  ProviderDispute,
} from '../application/ports/dispute-source';

// payments reaches this module through ordering (payments imports ordering, ordering imports
// commission-payouts), so this module cannot import payments or ordering without a module cycle.
// It provides these two ports unbound and refusing ("unavailable": the event is retried), and
// `CommissionPayoutsDisputesModule` binds the real ones at start, the way sellers binds its
// claim check to certification.

export class LateBoundDisputeSource implements DisputeSource {
  #bound: DisputeSource | null = null;

  bind(source: DisputeSource): void {
    this.#bound = source;
  }

  read(context: CallContext, disputeId: string): Promise<ProviderDispute | null | 'unavailable'> {
    return this.#bound === null
      ? Promise.resolve('unavailable')
      : this.#bound.read(context, disputeId);
  }
}

export class LateBoundOrderPaymentLookup implements OrderPaymentLookup {
  #bound: OrderPaymentLookup | null = null;

  bind(lookup: OrderPaymentLookup): void {
    this.#bound = lookup;
  }

  paymentIntentOf(
    context: CallContext,
    orderId: string,
  ): Promise<OrderPaymentAnswer | 'unavailable'> {
    return this.#bound === null
      ? Promise.resolve('unavailable')
      : this.#bound.paymentIntentOf(context, orderId);
  }
}
