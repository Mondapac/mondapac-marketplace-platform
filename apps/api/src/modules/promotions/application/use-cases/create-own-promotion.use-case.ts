import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_OWN_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { createPromotion } from '../write-flow';
import { ownViewOf, type OwnPromotionView } from '../views';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.create-own-promotion`: a seller creates a promotion of its own with its own money. It goes live at once and enters the admin review queue, unless the seller has been active for fewer days than the Market's limit or the discount is above the approval threshold: then it waits for approval (PENDING_APPROVAL). */
export class CreateOwnPromotion extends UseCase<unknown, OwnPromotionView, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.create-own-promotion',
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
    const result = await createPromotion(this.deps, context, input, 'seller');
    return result.ok ? ok(ownViewOf(result.value, undefined)) : result;
  }
}
