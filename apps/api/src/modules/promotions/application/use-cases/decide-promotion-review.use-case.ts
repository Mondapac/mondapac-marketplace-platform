import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { decideReview, type ReviewItem } from '../review-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.decide-promotion-review`: an admin approves or rejects an entry of the review queue. */
export class DecidePromotionReview extends UseCase<
  {
    readonly reviewId?: unknown;
    readonly decision?: unknown;
    readonly promotionVersion?: unknown;
  },
  ReviewItem,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.decide-promotion-review',
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
    input: {
      readonly reviewId?: unknown;
      readonly decision?: unknown;
      readonly promotionVersion?: unknown;
    },
  ): Promise<Result<ReviewItem, PromotionsFailure>> {
    return decideReview(this.deps, context, input);
  }
}
