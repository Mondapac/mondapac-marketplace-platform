import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  cashbackOnDelivery,
  type CreditFlowFailure,
  type CreditFlowOutput,
  type DeliveryInput,
} from '../credit-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/**
 * `promotions.cashback-on-delivery`: the handler of `ordering.seller-order-delivered.v1` that
 * credits cashback to the customer's wallet (rule `system`: the Market's system actor from the
 * event envelope). Idempotent per seller order; a refusal throws in the subscriber, so the
 * delivery is retried and dead-lettered with an alert after its last attempt.
 */
export class CashbackOnDelivery extends UseCase<
  DeliveryInput,
  CreditFlowOutput,
  CreditFlowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.cashback-on-delivery',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: DeliveryInput,
  ): Promise<Result<CreditFlowOutput, CreditFlowFailure>> {
    return cashbackOnDelivery(this.deps, context, input);
  }
}
