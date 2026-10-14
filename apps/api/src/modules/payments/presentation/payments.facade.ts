import type { CallContext } from '@mondapac/shared-kernel';
import type { PayoutReadinessQuery } from '../application/use-cases/payout-readiness.use-case';
import type { PaymentsFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class PaymentsFacadeImplementation implements PaymentsFacade {
  constructor(private readonly readiness: PayoutReadinessQuery) {}

  payoutReadiness(context: CallContext, sellerIds: readonly string[]) {
    return this.readiness.execute(context, sellerIds);
  }
}
