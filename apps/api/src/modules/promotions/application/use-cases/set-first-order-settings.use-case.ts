import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { setFirstOrder, type FirstOrderView } from '../admin-settings-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.set-first-order-settings`: an admin sets the first-order discount: switch, type, amount, cap, minimum spend and monthly budget. A monthly budget above the Market threshold needs a fresh two-step code. */
export class SetFirstOrderSettings extends UseCase<
  Parameters<typeof setFirstOrder>[2],
  FirstOrderView,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.set-first-order-settings',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Parameters<typeof setFirstOrder>[2],
  ): Promise<Result<FirstOrderView, PromotionsFailure>> {
    return setFirstOrder(this.deps, context, input);
  }
}
