import { money } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { PaymentsFacade } from '../../payments';
import type {
  AbandonAnswer,
  InstructAnswer,
  PaymentsPayouts,
  TransferLookup,
} from '../application/ports/payout-gateways';

/**
 * {@link PaymentsPayouts} on the payments facade, called as the system actor. `payments.unavailable`
 * and any refusal of the call itself are `unavailable`: an unknown outcome, never "not sent".
 */
export class PaymentsFacadePayouts implements PaymentsPayouts {
  constructor(private readonly payments: PaymentsFacade) {}

  async readiness(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    const result = await this.payments.payoutReadiness(context, sellerIds);
    if (!result.ok) return 'unavailable' as const;
    return new Map(
      result.value.map((row): [Id<'Seller'>, boolean] => [row.sellerId as Id<'Seller'>, row.ready]),
    );
  }

  async instruct(
    context: CallContext,
    request: {
      readonly instructionKey: string;
      readonly sellerId: Id<'Seller'>;
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly reference: string;
    },
  ): Promise<InstructAnswer | 'unavailable'> {
    const result = await this.payments.instructTransfer(context, {
      instructionKey: request.instructionKey,
      sellerId: request.sellerId,
      amount: money(request.amountMinor, request.currency),
      reference: request.reference,
    });
    if (!result.ok) return 'unavailable';
    return result.value;
  }

  async lookup(
    context: CallContext,
    instructionKeys: readonly string[],
  ): Promise<readonly TransferLookup[] | 'unavailable'> {
    const result = await this.payments.transferByKey(context, instructionKeys);
    if (!result.ok) return 'unavailable';
    return result.value.map((row) => ({
      instructionKey: row.instructionKey,
      state: row.state,
      transferExecutionId: row.transferExecutionId,
      amountMinor: row.amount?.amount ?? null,
      currency: row.amount?.currency ?? null,
    }));
  }

  async abandon(
    context: CallContext,
    instructionKey: string,
  ): Promise<AbandonAnswer | 'unavailable'> {
    const result = await this.payments.abandonTransfer(context, instructionKey);
    if (!result.ok) return 'unavailable';
    return result.value.kind === 'abandoned'
      ? { kind: 'abandoned' }
      : result.value.kind === 'still-abandoned'
        ? { kind: 'still-abandoned' }
        : result.value.kind === 'already-sent'
          ? { kind: 'already-sent', transferExecutionId: result.value.transferExecutionId }
          : { kind: 'in-flight' };
  }
}
