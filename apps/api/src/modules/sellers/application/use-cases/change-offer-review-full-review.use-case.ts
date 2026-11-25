import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_OFFER_REVIEW_FULL_MANAGE } from '../../contracts/permissions';
import { OfferReviewFullReviewChanged } from '../../domain/audit';
import {
  changeOfferReviewFlag,
  type ChangeOfferReviewFlagDependencies,
  type ChangeOfferReviewFlagFailure,
  type ChangeOfferReviewFlagInput,
  type ChangeOfferReviewFlagResult,
  type OfferReviewFlagSpec,
} from '../offer-review-flags/change-offer-review-flag';

const SPEC: OfferReviewFlagSpec = {
  flag: 'full-review',
  name: 'sellers.change-offer-review-full-review',
  stepUpAction: null,
  auditEntry: (sellerId, change) =>
    OfferReviewFullReviewChanged.entry(sellerId, {
      before: { on: change.before },
      after: { on: change.after },
    }),
};

/**
 * `sellers.change-offer-review-full-review` (SEL-25, R6; risk-based Offer approval slice 4,
 * ADR-0051 decision 4): an admin switches a seller's full-review flag. While on, every first
 * publication of the seller waits for an admin; watched edits are not held by it (owner answer 4).
 * Rule `permissions [sellers.offer-review-full.manage]` (not protected, no step-up); admin
 * population only, never in an acting-as session. The flow is {@link changeOfferReviewFlag}.
 */
export class ChangeOfferReviewFullReviewUseCase extends UseCase<
  ChangeOfferReviewFlagInput,
  ChangeOfferReviewFlagResult,
  ChangeOfferReviewFlagFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.change-offer-review-full-review',
    rule: { kind: 'permissions', allOf: [SELLERS_OFFER_REVIEW_FULL_MANAGE.key] },
  };

  readonly #logger = new Logger('ChangeOfferReviewFullReview');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeOfferReviewFlagDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ChangeOfferReviewFlagInput,
  ): Promise<Result<ChangeOfferReviewFlagResult, ChangeOfferReviewFlagFailure>> {
    return changeOfferReviewFlag(this.deps, SPEC, this.#logger, context, input);
  }
}
