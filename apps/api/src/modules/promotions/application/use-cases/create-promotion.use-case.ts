import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { createPromotion } from '../write-flow';
import { promotionViewOf, type PromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.create-promotion`: an admin creates a platform promotion (platform-funded or a co-funded campaign). Platform money above the Market threshold, and a special campaign, need a fresh two-step code; platform money is test mode only until the Market confirms the tax ruling. */
export class CreatePromotion extends UseCase<unknown, PromotionView, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.create-promotion',
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
    input: unknown,
  ): Promise<Result<PromotionView, PromotionsFailure>> {
    const result = await createPromotion(this.deps, context, input, 'admin');
    return result.ok ? ok(promotionViewOf(result.value, undefined)) : result;
  }
}
