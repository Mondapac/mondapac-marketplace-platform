import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  qualifyReferralOnDelivery,
  type CreditFlowFailure,
  type CreditFlowOutput,
  type DeliveryInput,
} from '../credit-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/**
 * `promotions.qualify-referral-on-delivery`: the handler of `ordering.seller-order-delivered.v1`
 * that rewards a referral when the referred customer's qualifying order is delivered (rule
 * `system`). Idempotent per referral; abuse checks and the promotion's limits run first.
 */
export class QualifyReferralOnDelivery extends UseCase<
  DeliveryInput,
  CreditFlowOutput,
  CreditFlowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.qualify-referral-on-delivery',
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
    return qualifyReferralOnDelivery(this.deps, context, input);
  }
}
