import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_OWN_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { changePause } from '../write-flow';
import { ownViewOf, type OwnPromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.pause-own-promotion`: a seller pauses its own promotion. */
export class PauseOwnPromotion extends UseCase<
  { readonly promotionId?: unknown },
  OwnPromotionView,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.pause-own-promotion',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_OWN_PROMOTION_MANAGE.key] },
    whenSellerNotApproved: 'deny',
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
  ): Promise<Result<OwnPromotionView, PromotionsFailure>> {
    const result = await changePause(this.deps, context, input, 'seller', true);
    return result.ok ? ok(ownViewOf(result.value, undefined)) : result;
  }
}
