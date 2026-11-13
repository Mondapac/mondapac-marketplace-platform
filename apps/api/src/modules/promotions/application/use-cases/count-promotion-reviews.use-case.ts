import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import { countOpenReviews } from '../admin-read-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.count-promotion-reviews`: how many entries of the review queue are open. */
export class CountPromotionReviews extends UseCase<
  Record<string, never>,
  { readonly open: number },
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.count-promotion-reviews',
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
  ): Promise<Result<{ readonly open: number }, PromotionsFailure>> {
    return countOpenReviews(this.deps, context);
  }
}
