import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { viewFirstOrder, type FirstOrderView } from '../admin-settings-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.view-first-order-settings`: an admin reads the first-order discount in force in the Market. */
export class ViewFirstOrderSettings extends UseCase<
  Record<string, never>,
  FirstOrderView,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.view-first-order-settings',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<FirstOrderView, PromotionsFailure>> {
    return viewFirstOrder(this.deps, context);
  }
}

export type { FirstOrderView } from '../admin-settings-flow';
