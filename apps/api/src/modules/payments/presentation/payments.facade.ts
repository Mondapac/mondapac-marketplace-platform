import type { CallContext } from '@mondapac/shared-kernel';
import type { DisputeOfQuery } from '../application/use-cases/dispute-of.use-case';
import type { DisputesOfOrderQuery } from '../application/use-cases/disputes-of-order.use-case';
import type { PayoutReadinessQuery } from '../application/use-cases/payout-readiness.use-case';
import type { PaymentsFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class PaymentsFacadeImplementation implements PaymentsFacade {
  constructor(
    private readonly readiness: PayoutReadinessQuery,
    private readonly disputes: DisputeOfQuery,
    private readonly orderDisputes: DisputesOfOrderQuery,
  ) {}

  payoutReadiness(context: CallContext, sellerIds: readonly string[]) {
    return this.readiness.execute(context, sellerIds);
  }

  disputeOf(context: CallContext, disputeIds: readonly string[]) {
    return this.disputes.execute(context, disputeIds);
  }

  disputesOfOrder(context: CallContext, orderId: string) {
    return this.orderDisputes.execute(context, orderId);
  }
}
