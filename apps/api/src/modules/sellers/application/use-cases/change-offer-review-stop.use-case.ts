import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_OFFER_REVIEW_STOP_MANAGE } from '../../contracts/permissions';
import { SELLERS_OFFER_REVIEW_STOP_STEP_UP } from '../../contracts/step-up';
import { OfferReviewStopChanged } from '../../domain/audit';
import {
  changeOfferReviewFlag,
  type ChangeOfferReviewFlagDependencies,
  type ChangeOfferReviewFlagFailure,
  type ChangeOfferReviewFlagInput,
  type ChangeOfferReviewFlagResult,
  type OfferReviewFlagSpec,
} from '../offer-review-flags/change-offer-review-flag';

const SPEC: OfferReviewFlagSpec = {
  flag: 'review-stop',
  name: 'sellers.change-offer-review-stop',
  stepUpAction: SELLERS_OFFER_REVIEW_STOP_STEP_UP,
  auditEntry: (sellerId, change) =>
    OfferReviewStopChanged.entry(sellerId, {
      before: { on: change.before },
      after: { on: change.after, stepUpVerifiedAt: change.verifiedAt ?? null },
    }),
};

/**
 * `sellers.change-offer-review-stop` (SEL-25; risk-based Offer approval slice 4, ADR-0051
 * decision 4; owner answer 1): an admin switches a seller's Offer review stop (R0 for one seller).
 * While on, the seller's first publications and watched edits of live Offers wait for an admin,
 * in every mode (also `off`); live Offers stay live. Rule `permissions
 * [sellers.offer-review-stop.manage]` (protected); admin population only, never in an acting-as
 * session; a fresh two-step code (`sellers.offer-review-stop.change`) is spent in the change's
 * unit. The flow is {@link changeOfferReviewFlag}.
 */
export class ChangeOfferReviewStopUseCase extends UseCase<
  ChangeOfferReviewFlagInput,
  ChangeOfferReviewFlagResult,
  ChangeOfferReviewFlagFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.change-offer-review-stop',
    rule: { kind: 'permissions', allOf: [SELLERS_OFFER_REVIEW_STOP_MANAGE.key] },
  };

  readonly #logger = new Logger('ChangeOfferReviewStop');

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
