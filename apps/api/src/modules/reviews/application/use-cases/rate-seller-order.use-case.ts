import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewsFailure } from '../failures';
import type { OwnSellerRatingView } from '../views';
import { rateSellerOrder, type RateSellerOrderInput } from '../write-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.rate-seller-order`: the buyer rates a delivered seller order of their own (once). */
export class RateSellerOrder extends UseCase<
  RateSellerOrderInput,
  OwnSellerRatingView,
  ReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.rate-seller-order',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RateSellerOrderInput) {
    return rateSellerOrder(this.deps, context, input);
  }
}

export type { OwnSellerRatingView } from '../views';
