import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsDependencies } from '../promotions-dependencies';
import {
  redeem,
  type RedeemFailure,
  type RedeemInput,
  type RedeemOutput,
} from '../redemption-flow';

export type { RedeemFailure } from '../redemption-flow';

/**
 * `promotions.redeem-discounts`: the checkout saga's redemption of the discounts a stored order
 * holds (rule `system`: ordering calls it with the customer's order, never a browser). Reserves
 * them under row locks, or answers the fresh quote when they changed. Idempotent per order.
 */
export class RedeemDiscounts extends UseCase<RedeemInput, RedeemOutput, RedeemFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.redeem-discounts',
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
    input: RedeemInput,
  ): Promise<Result<RedeemOutput, RedeemFailure>> {
    return redeem(this.deps, context, input);
  }
}
