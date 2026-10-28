import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { listReviews, type ReviewItem } from '../review-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.list-promotion-reviews`: the admin review queue of seller promotions, oldest first. */
export class ListPromotionReviews extends UseCase<
  Record<string, never>,
  readonly ReviewItem[],
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-promotion-reviews',
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
  ): Promise<Result<readonly ReviewItem[], PromotionsFailure>> {
    return listReviews(this.deps, context);
  }
}

export type { ReviewItem } from '../review-flow';
