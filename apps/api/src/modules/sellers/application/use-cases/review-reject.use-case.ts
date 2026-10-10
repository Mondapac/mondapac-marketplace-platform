import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLER_ACCESS_APPROVE } from '../../../identity';
import {
  decideOnRevision,
  logDecision,
  type ReviewDecided,
  type ReviewDecisionDependencies,
  type ReviewDecisionFailure,
  type ReviewDecisionInput,
} from '../review/decision-request';

/**
 * `review.reject` (sellers design 3.1, 6.2, 7.3; slice 7a-decide): a reviewer rejects revision N
 * with a reason. Same rule and flow as `sellers.review-approve`, without the register guard or the
 * claim. The reason goes to `identity` (stored encrypted there, mailed to the Seller Owner);
 * `sellers` never stores or logs it.
 */
export class ReviewReject extends UseCase<
  ReviewDecisionInput,
  ReviewDecided,
  ReviewDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.review-reject',
    rule: { kind: 'permissions', allOf: [SELLER_ACCESS_APPROVE.key] },
  };

  readonly #logger = new Logger('ReviewReject');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewDecisionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReviewDecisionInput,
  ): Promise<Result<ReviewDecided, ReviewDecisionFailure>> {
    const result = await decideOnRevision(this.deps, context, input, 'reject');
    logDecision(this.#logger, 'sellers.review-reject', context, result);
    return result;
  }
}
