import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsDependencies } from '../promotions-dependencies';
import {
  releaseRedemptions,
  type RedemptionEventFailure,
  type RedemptionEventInput,
  type RedemptionEventOutput,
} from '../redemption-flow';

/**
 * `promotions.release-cancelled-redemptions`: the handler of `ordering.order-cancelled.v1` (rule
 * `system`). The cancelled order's redemptions are released and what they took (usage counters,
 * budget, first-order money, a single-use code) is given back. Idempotent through the inbox.
 */
export class ReleaseCancelledRedemptions extends UseCase<
  RedemptionEventInput,
  RedemptionEventOutput,
  RedemptionEventFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.release-cancelled-redemptions',
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
    return releaseRedemptions(this.deps, context, input, 'ORDER_CANCELLED');
  }
}
