import type { CallContext } from '@mondapac/shared-kernel';
import type { AbandonTransfer } from '../application/use-cases/abandon-transfer.use-case';
import type { DisputeOfQuery } from '../application/use-cases/dispute-of.use-case';
import type { InstructTransfer } from '../application/use-cases/instruct-transfer.use-case';
import type { PayoutReadinessQuery } from '../application/use-cases/payout-readiness.use-case';
import type { TransferByKeyQuery } from '../application/use-cases/transfer-by-key.use-case';
import type { InstructTransferRequest, PaymentsFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class PaymentsFacadeImplementation implements PaymentsFacade {
  constructor(
    private readonly readiness: PayoutReadinessQuery,
    private readonly disputes: DisputeOfQuery,
    private readonly instruct: InstructTransfer,
    private readonly byKey: TransferByKeyQuery,
    private readonly abandon: AbandonTransfer,
  ) {}

  payoutReadiness(context: CallContext, sellerIds: readonly string[]) {
    return this.readiness.execute(context, sellerIds);
  }

  disputeOf(context: CallContext, disputeIds: readonly string[]) {
    return this.disputes.execute(context, disputeIds);
  }

  instructTransfer(context: CallContext, request: InstructTransferRequest) {
    return this.instruct.execute(context, request);
  }

  transferByKey(context: CallContext, instructionKeys: readonly string[]) {
    return this.byKey.execute(context, instructionKeys);
  }

  abandonTransfer(context: CallContext, instructionKey: string) {
    return this.abandon.execute(context, instructionKey);
  }
}
