import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { clawBackOnRefund, type ClawbackOutcome, type RefundInput } from '../clawback-flow';
import type { CreditFlowFailure } from '../credit-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/**
 * `promotions.claw-back-on-refund`: the handler of `ordering.refund-succeeded.v1` that takes back
 * from the customer's wallet the part of a credited cashback that the goods given back no longer
 * earn (customers phase 4c-2; rule `system`: the Market's system actor from the event envelope).
 * Idempotent per refund; a refusal throws in the subscriber, so the delivery is retried and
 * dead-lettered with an alert after its last attempt.
 */
export class ClawBackOnRefund extends UseCase<
  RefundInput,
  { readonly outcome: ClawbackOutcome },
  CreditFlowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.claw-back-on-refund',
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
    input: RefundInput,
  ): Promise<Result<{ readonly outcome: ClawbackOutcome }, CreditFlowFailure>> {
    return clawBackOnRefund(this.deps, context, input);
  }
}
