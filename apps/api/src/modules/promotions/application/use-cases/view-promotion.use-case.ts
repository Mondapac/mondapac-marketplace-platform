import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { viewOne } from '../read-flow';
import type { PromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.view-promotion`: one promotion with its terms, budget and the money used. */
export class ViewPromotion extends UseCase<
  { readonly promotionId?: unknown },
  PromotionView,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.view-promotion',
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
    input: { readonly promotionId?: unknown },
  ): Promise<Result<PromotionView, PromotionsFailure>> {
    return viewOne(this.deps, context, input);
  }
}
