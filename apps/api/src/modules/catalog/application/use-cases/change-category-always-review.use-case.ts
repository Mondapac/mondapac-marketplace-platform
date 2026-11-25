import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_REVIEW_MANAGE } from '../../contracts/permissions';
import { CATALOG_CATEGORY_REVIEW_STEP_UP } from '../../contracts/step-up';
import { CategoryOfferReviewChangedAudit } from '../../domain/audit';
import {
  changeCategoryOfferReviewFlag,
  type CategoryOfferReviewFlagSpec,
  type ChangeCategoryOfferReviewFlagDependencies,
  type ChangeCategoryOfferReviewFlagFailure,
  type ChangeCategoryOfferReviewFlagInput,
  type ChangeCategoryOfferReviewFlagResult,
} from '../offer-review-flags/change-category-offer-review-flag';

const SPEC: CategoryOfferReviewFlagSpec = {
  flag: 'always-review',
  name: 'catalog.change-category-always-review',
  stepUpAction: CATALOG_CATEGORY_REVIEW_STEP_UP,
  auditEntry: (categoryId, change) =>
    CategoryOfferReviewChangedAudit.entry(categoryId, {
      before: { on: change.before },
      after: { on: change.after, stepUpVerifiedAt: change.verifiedAt },
    }),
};

/**
 * `catalog.change-category-always-review` (R7; risk-based Offer approval slice 4, ADR-0051
 * decision 4): an admin marks a platform category "always review", or clears it. While on, the
 * first publication of an Offer of a product in it (or in a sub-category) waits for an admin
 * (`sensitive-category`), and so does a watched edit of a live one (owner answer 4). Rule
 * `permissions [catalog.category-review.manage]` (protected); admin population only, never in an
 * acting-as session; a fresh two-step code (`catalog.category-review.change`) is spent in the
 * change's unit. The list ships empty: it is admin data, never code. The flow is
 * {@link changeCategoryOfferReviewFlag}.
 */
export class ChangeCategoryAlwaysReview extends UseCase<
  ChangeCategoryOfferReviewFlagInput,
  ChangeCategoryOfferReviewFlagResult,
  ChangeCategoryOfferReviewFlagFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.change-category-always-review',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_REVIEW_MANAGE.key] },
  };

  readonly #logger = new Logger('ChangeCategoryAlwaysReview');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeCategoryOfferReviewFlagDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ChangeCategoryOfferReviewFlagInput,
  ): Promise<Result<ChangeCategoryOfferReviewFlagResult, ChangeCategoryOfferReviewFlagFailure>> {
    return changeCategoryOfferReviewFlag(this.deps, SPEC, this.#logger, context, input);
  }
}
