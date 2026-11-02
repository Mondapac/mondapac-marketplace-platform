import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SummaryFailure } from '../failures';
import { countSellerReviews, type SellerReviewCount } from '../read-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

interface Input {
  readonly sellerId?: unknown;
  readonly windows?: unknown;
}

/**
 * `reviews.count-seller-reviews`: the seller health feed (rule `system`): how many reviews of a
 * seller were published in each of a few windows, and their stars, in one read. Counters only, never text or author. The
 * nightly health job of `sellers` calls it through the reviews facade.
 */
export class CountSellerReviews extends UseCase<
  Input,
  readonly SellerReviewCount[],
  SummaryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.count-seller-reviews',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return countSellerReviews(this.deps, context, input);
  }
}
