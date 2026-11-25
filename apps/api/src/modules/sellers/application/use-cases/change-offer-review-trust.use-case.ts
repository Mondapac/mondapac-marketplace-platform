import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_OFFER_REVIEW_TRUST_MANAGE } from '../../contracts/permissions';
import { SELLERS_OFFER_REVIEW_TRUST_STEP_UP } from '../../contracts/step-up';
import { OfferReviewTrustChanged } from '../../domain/audit';
import {
  changeOfferReviewFlag,
  type ChangeOfferReviewFlagDependencies,
  type ChangeOfferReviewFlagFailure,
  type ChangeOfferReviewFlagInput,
  type ChangeOfferReviewFlagResult,
  type OfferReviewFlagSpec,
} from '../offer-review-flags/change-offer-review-flag';

/** The shared input, result and failure of the three flag changes, for the controller. */
export type {
  ChangeOfferReviewFlagFailure,
  ChangeOfferReviewFlagInput,
  ChangeOfferReviewFlagResult,
} from '../offer-review-flags/change-offer-review-flag';

const SPEC: OfferReviewFlagSpec = {
  flag: 'trusted-from-start',
  name: 'sellers.change-offer-review-trust',
  stepUpAction: SELLERS_OFFER_REVIEW_TRUST_STEP_UP,
  auditEntry: (sellerId, change) =>
    OfferReviewTrustChanged.entry(sellerId, {
      before: { on: change.before },
      after: { on: change.after, stepUpVerifiedAt: change.verifiedAt ?? null },
    }),
};

/**
 * `sellers.change-offer-review-trust` (SEL-25; risk-based Offer approval slice 4, ADR-0051
 * decision 4): an admin switches a seller's Trusted-from-start flag. Rule `permissions
 * [sellers.offer-review-trust.manage]` (protected); admin population only, never in an acting-as
 * session; a fresh two-step code (`sellers.offer-review-trust.change`) is spent in the change's
 * unit. Switching it on after a misconduct revocation restarts Trusted (and its 30 days of double
 * sampling); switching it off returns the seller to probation with its current count. The flow is
 * {@link changeOfferReviewFlag}.
 */
export class ChangeOfferReviewTrustUseCase extends UseCase<
  ChangeOfferReviewFlagInput,
  ChangeOfferReviewFlagResult,
  ChangeOfferReviewFlagFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.change-offer-review-trust',
    rule: { kind: 'permissions', allOf: [SELLERS_OFFER_REVIEW_TRUST_MANAGE.key] },
  };

  readonly #logger = new Logger('ChangeOfferReviewTrust');

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
