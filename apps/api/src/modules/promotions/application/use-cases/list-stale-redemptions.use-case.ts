import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsDependencies } from '../promotions-dependencies';
import {
  staleRedemptions,
  type RedemptionEventFailure,
  type StaleRedemptionsInput,
} from '../redemption-flow';

/**
 * `promotions.list-stale-redemptions`: the orders that still hold RESERVED redemptions written
 * before an instant, oldest first, at most 100 (rule `system`: ordering's safety sweep, package
 * T2). Ids only; read only.
 */
export class ListStaleRedemptions extends UseCase<
  StaleRedemptionsInput,
  readonly Id<'Order'>[],
  RedemptionEventFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-stale-redemptions',
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
    input: StaleRedemptionsInput,
  ): Promise<Result<readonly Id<'Order'>[], RedemptionEventFailure>> {
    return staleRedemptions(this.deps, context, input);
  }
}
