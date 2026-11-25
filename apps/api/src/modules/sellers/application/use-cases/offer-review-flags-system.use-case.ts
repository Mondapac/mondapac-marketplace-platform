import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  offerReviewFlagsFor,
  type OfferReviewFlagsDependencies,
  type OfferReviewFlagsFailure,
  type OfferReviewFlagsInput,
  type OfferReviewFlagsOf,
} from './offer-review-flags.use-case';

/** `offerReviewFlagsOf` for event handlers and jobs: rule `system`, the same answer. */
export class OfferReviewFlagsSystem extends UseCase<
  OfferReviewFlagsInput,
  OfferReviewFlagsOf,
  OfferReviewFlagsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.offer-review-flags-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferReviewFlagsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: OfferReviewFlagsInput,
  ): Promise<Result<OfferReviewFlagsOf, OfferReviewFlagsFailure>> {
    return offerReviewFlagsFor(this.deps, context, input?.sellerId);
  }
}
