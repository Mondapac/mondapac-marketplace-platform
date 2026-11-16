import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsDependencies } from '../promotions-dependencies';
import {
  confirmRedemptions,
  type RedemptionEventFailure,
  type RedemptionEventInput,
  type RedemptionEventOutput,
} from '../redemption-flow';

/**
 * `promotions.confirm-redemptions`: the handler of `ordering.order-paid.v1` (rule `system`: the
 * Market's system actor from the event envelope). The order's reserved redemptions become
 * confirmed. Idempotent through the inbox.
 */
export class ConfirmRedemptions extends UseCase<
  RedemptionEventInput,
  RedemptionEventOutput,
  RedemptionEventFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.confirm-redemptions',
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
    input: RedemptionEventInput,
  ): Promise<Result<RedemptionEventOutput, RedemptionEventFailure>> {
    return confirmRedemptions(this.deps, context, input);
  }
}
