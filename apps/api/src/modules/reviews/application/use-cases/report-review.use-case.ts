import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_SELLER_REPORT } from '../../contracts/permissions';
import type { ReviewsFailure } from '../failures';
import type { ReviewsDependencies } from '../reviews-dependencies';
import { reportReview } from '../seller-flow';

/** `reviews.report-review`: Reports a review of the shop to the moderators with a reason code; the shop cannot hide it. */
export class ReportReview extends UseCase<
  { readonly reviewId?: unknown; readonly reasonCode?: unknown },
  { readonly reported: true },
  ReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.report-review',
    rule: { kind: 'permissions', allOf: [REVIEWS_SELLER_REPORT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly reviewId?: unknown; readonly reasonCode?: unknown },
  ) {
    return reportReview(this.deps, context, input);
  }
}
