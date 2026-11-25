import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_SETTINGS_VIEW } from '../../contracts/permissions';
import {
  countMarketReviews,
  type MarketReviewCount,
  type MarketReviewsFailure,
} from '../market-review-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

interface Input {
  readonly windows?: unknown;
}

/**
 * `reviews.count-market-reviews`: the review numbers of the admin dashboard (dashboards v2, phase
 * 2): how many reviews the Market published in each of a few windows, their stars and the count of
 * each rating. Counters only, never text, author, product or seller. Key `reviews.settings.view`
 * (protected: only the Platform Administrator holds it), a platform admin acting as themselves.
 */
export class CountMarketReviews extends UseCase<
  Input,
  readonly MarketReviewCount[],
  MarketReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.count-market-reviews',
    rule: { kind: 'permissions', allOf: [REVIEWS_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return countMarketReviews(this.deps, context, input);
  }
}
