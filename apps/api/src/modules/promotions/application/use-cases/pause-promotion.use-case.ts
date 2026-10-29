import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { changePause } from '../write-flow';
import { promotionViewOf, type PromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.pause-promotion`: an admin pauses any promotion, a seller's included. */
export class PausePromotion extends UseCase<
  { readonly promotionId?: unknown },
  PromotionView,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.pause-promotion',
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
    input: { readonly promotionId?: unknown },
  ): Promise<Result<PromotionView, PromotionsFailure>> {
    const result = await changePause(this.deps, context, input, 'admin', true);
    return result.ok ? ok(promotionViewOf(result.value, undefined)) : result;
  }
}
