import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { listThresholds, type ThresholdsView } from '../admin-settings-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.list-free-shipping-thresholds`: an admin reads the free-shipping thresholds per delivery zone and the Market default. */
export class ListFreeShippingThresholds extends UseCase<
  Record<string, never>,
  ThresholdsView,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-free-shipping-thresholds',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<ThresholdsView, PromotionsFailure>> {
    return listThresholds(this.deps, context);
  }
}

export type { ThresholdsView } from '../admin-settings-flow';
