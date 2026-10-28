import type { CallContext } from '@mondapac/shared-kernel';
import type { PaymentsFacade } from '../../payments';
import type { DisputeSource, ProviderDispute } from '../application/ports/dispute-source';

/** {@link DisputeSource} on payments' `disputeOf`, read as the system actor. */
export class PaymentsDisputeSource implements DisputeSource {
  constructor(private readonly payments: PaymentsFacade) {}

  async read(
    context: CallContext,
    disputeId: string,
  ): Promise<ProviderDispute | null | 'unavailable'> {
    const result = await this.payments.disputeOf(context, [disputeId]);
    if (!result.ok) return 'unavailable';
    const found = result.value.find((dispute) => dispute.disputeId === disputeId);
    return found === undefined ? null : found;
  }
}
