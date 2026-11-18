import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CustomerReviewsFailure } from '../../contracts/customer-reviews.facade';
import { readReviewAuthor, type AdminCustomerReviewsDependencies } from '../admin-customer-reviews';

type Answer = { readonly accountId: Id<'Account'> | null };

/**
 * `reviews.review-author-of`: the author of one review by its internal id, for customers' timeline
 * subscriber (customers management phase 2b, part 3: a review event lands on its author's
 * timeline; reviews' events carry no account on purpose). Rule `system`: no person reaches it, so
 * no seller can tie a review to a buyer through it. Answers whether reviews are on or off.
 */
export class ReviewAuthorOf extends UseCase<
  { readonly reviewId: string },
  Answer,
  CustomerReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.review-author-of',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCustomerReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly reviewId: string },
  ): Promise<Result<Answer, CustomerReviewsFailure>> {
    return readReviewAuthor(this.deps, context, input);
  }
}
