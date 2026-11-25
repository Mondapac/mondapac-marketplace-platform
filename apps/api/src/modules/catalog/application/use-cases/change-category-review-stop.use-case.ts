import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OFFER_REVIEW_STOP_MANAGE } from '../../contracts/permissions';
import { CATALOG_OFFER_REVIEW_STOP_STEP_UP } from '../../contracts/step-up';
import { CategoryReviewStopChangedAudit } from '../../domain/audit';
import {
  changeCategoryOfferReviewFlag,
  type CategoryOfferReviewFlagSpec,
  type ChangeCategoryOfferReviewFlagDependencies,
  type ChangeCategoryOfferReviewFlagFailure,
  type ChangeCategoryOfferReviewFlagInput,
  type ChangeCategoryOfferReviewFlagResult,
} from '../offer-review-flags/change-category-offer-review-flag';

const SPEC: CategoryOfferReviewFlagSpec = {
  flag: 'review-stop',
  name: 'catalog.change-category-review-stop',
  stepUpAction: CATALOG_OFFER_REVIEW_STOP_STEP_UP,
  auditEntry: (categoryId, change) =>
    CategoryReviewStopChangedAudit.entry(categoryId, {
      before: { on: change.before },
      after: { on: change.after, stepUpVerifiedAt: change.verifiedAt },
    }),
};

/**
 * `catalog.change-category-review-stop` (R0 for one category; risk-based Offer approval slice 4,
 * ADR-0051 decision 4): an admin switches a platform category's Offer review stop. While on, the
 * first publications and watched edits of Offers of products in it (or in a sub-category) wait for
 * an admin, in every mode (also `off`); live Offers stay live. Rule `permissions
 * [catalog.offer-review-stop.manage]` (protected); admin population only, never in an acting-as
 * session; a fresh two-step code (`catalog.offer-review-stop.change`) is spent in the change's
 * unit. The flow is {@link changeCategoryOfferReviewFlag}.
 */
export class ChangeCategoryReviewStop extends UseCase<
  ChangeCategoryOfferReviewFlagInput,
  ChangeCategoryOfferReviewFlagResult,
  ChangeCategoryOfferReviewFlagFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.change-category-review-stop',
    rule: { kind: 'permissions', allOf: [CATALOG_OFFER_REVIEW_STOP_MANAGE.key] },
  };

  readonly #logger = new Logger('ChangeCategoryReviewStop');

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
