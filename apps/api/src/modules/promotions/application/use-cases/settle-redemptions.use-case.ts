import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsDependencies } from '../promotions-dependencies';
import {
  settleRedemptions,
  type RedemptionEventFailure,
  type RedemptionEventOutput,
  type SettleRedemptionsInput,
} from '../redemption-flow';

/**
 * `promotions.settle-redemptions`: the safety sweep's settlement of one order's RESERVED
 * redemptions by what ordering says became of the order: `paid` confirms them, `cancelled`
 * releases them and gives back what they took (rule `system`, package T2). Idempotent.
 */
export class SettleRedemptions extends UseCase<
  SettleRedemptionsInput,
  RedemptionEventOutput,
  RedemptionEventFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.settle-redemptions',
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
    input: SettleRedemptionsInput,
  ): Promise<Result<RedemptionEventOutput, RedemptionEventFailure>> {
    return settleRedemptions(this.deps, context, input);
  }
}
