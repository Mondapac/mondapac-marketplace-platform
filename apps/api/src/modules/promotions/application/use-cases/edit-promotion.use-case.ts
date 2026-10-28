import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { editPromotion } from '../write-flow';
import { promotionViewOf, type PromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.edit-promotion`: an admin edits a platform promotion (not its type, funding or code). */
export class EditPromotion extends UseCase<unknown, PromotionView, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.edit-promotion',
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
    const result = await editPromotion(this.deps, context, input, 'admin');
    return result.ok ? ok(promotionViewOf(result.value, undefined)) : result;
  }
}
