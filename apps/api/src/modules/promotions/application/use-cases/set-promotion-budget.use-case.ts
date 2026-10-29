import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { setBudget } from '../write-flow';
import { promotionViewOf, type PromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.set-promotion-budget`: an admin sets the total budget of a platform promotion; a budget above the Market threshold needs a fresh two-step code. */
export class SetPromotionBudget extends UseCase<
  { readonly promotionId?: unknown; readonly budgetMinor?: unknown },
  PromotionView,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.set-promotion-budget',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly promotionId?: unknown; readonly budgetMinor?: unknown },
  ): Promise<Result<PromotionView, PromotionsFailure>> {
    const result = await setBudget(this.deps, context, input);
    return result.ok ? ok(promotionViewOf(result.value, undefined)) : result;
  }
}
