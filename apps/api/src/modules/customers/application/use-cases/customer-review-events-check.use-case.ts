import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_CUSTOMER_REVIEW_VIEW } from '../section-keys';

export interface CustomerReviewEventsCheckOutput {
  readonly canSeeReviewEvents: true;
}

export type CustomerReviewEventsCheckFailure = { readonly code: 'access.denied' };

/**
 * `customers.customer-review-events-check`: asks the gate whether the caller holds reviews' key
 * `reviews.customer-review.view`. It reads and writes nothing; the timeline read and export call
 * it to decide whether the review kinds (and the `reviews` category) are part of the answer, so
 * the key is checked by the gate, in one place (phase 2b, part 3; security review L1). The answer
 * `access.denied` means "no"; the admin population is required as for every admin use case.
 */
export class CustomerReviewEventsCheck extends UseCase<
  Record<string, never>,
  CustomerReviewEventsCheckOutput,
  CustomerReviewEventsCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.customer-review-events-check',
    rule: { kind: 'permissions', allOf: [REVIEWS_CUSTOMER_REVIEW_VIEW] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<CustomerReviewEventsCheckOutput, CustomerReviewEventsCheckFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return Promise.resolve(ok({ canSeeReviewEvents: true }));
  }
}
