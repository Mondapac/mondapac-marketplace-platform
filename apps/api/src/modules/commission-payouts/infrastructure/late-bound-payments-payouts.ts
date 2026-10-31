import type { CallContext, Id } from '@mondapac/shared-kernel';
import type {
  AbandonAnswer,
  InstructAnswer,
  PaymentsPayouts,
  TransferLookup,
} from '../application/ports/payout-gateways';

// payments reaches this module through ordering (payments imports ordering, ordering imports
// commission-payouts), so this module cannot import payments without a module cycle. As for the
// dispute reads, it provides this port unbound and refusing ("unavailable": nothing is decided,
// everything is asked again later) and `CommissionPayoutsDisputesModule` binds the real one at start.

export class LateBoundPaymentsPayouts implements PaymentsPayouts {
  #bound: PaymentsPayouts | null = null;

  bind(payouts: PaymentsPayouts): void {
    this.#bound = payouts;
  }

  readiness(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    return this.#bound === null
      ? Promise.resolve('unavailable' as const)
      : this.#bound.readiness(context, sellerIds);
  }

  instruct(
    context: CallContext,
    request: Parameters<PaymentsPayouts['instruct']>[1],
  ): Promise<InstructAnswer | 'unavailable'> {
    return this.#bound === null
      ? Promise.resolve('unavailable')
      : this.#bound.instruct(context, request);
  }

  lookup(
    context: CallContext,
    instructionKeys: readonly string[],
  ): Promise<readonly TransferLookup[] | 'unavailable'> {
    return this.#bound === null
      ? Promise.resolve('unavailable')
      : this.#bound.lookup(context, instructionKeys);
  }

  abandon(context: CallContext, instructionKey: string): Promise<AbandonAnswer | 'unavailable'> {
    return this.#bound === null
      ? Promise.resolve('unavailable')
      : this.#bound.abandon(context, instructionKey);
  }
}
