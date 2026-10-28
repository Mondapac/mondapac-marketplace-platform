import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_OWN_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { editPromotion } from '../write-flow';
import { ownViewOf, type OwnPromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.edit-own-promotion`: a seller edits its own promotion (not its type or code); an edit is reviewed again. */
export class EditOwnPromotion extends UseCase<unknown, OwnPromotionView, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.edit-own-promotion',
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
    input: unknown,
  ): Promise<Result<OwnPromotionView, PromotionsFailure>> {
    const result = await editPromotion(this.deps, context, input, 'seller');
    return result.ok ? ok(ownViewOf(result.value, undefined)) : result;
  }
}
