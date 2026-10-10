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
 * `review.approve` (sellers design 3.1, 6.2, 7.3; slice 7a-decide): a reviewer approves the
 * pending onboarding revision N of a seller. Rule `permissions [identity.seller-access.approve]`,
 * checked here and again by `identity` (double gate). The flow is {@link decideOnRevision}: the
 * register guard and the identifier claim under the file's lock, then `identity` decides with
 * `basisId` = N, then the approval is recorded (the approved pointer, the public store name, the
 * public slug).
 */
export class ReviewApprove extends UseCase<
  ReviewDecisionInput,
  ReviewDecided,
  ReviewDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.review-approve',
    rule: { kind: 'permissions', allOf: [SELLER_ACCESS_APPROVE.key] },
  };

  readonly #logger = new Logger('ReviewApprove');

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
    const result = await decideOnRevision(this.deps, context, input, 'approve');
    logDecision(this.#logger, 'sellers.review-approve', context, result);
    return result;
  }
}
