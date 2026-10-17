import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_APPROVE } from '../../contracts/permissions';
import {
  decide,
  type DecisionFailure,
  type DecisionInput,
  type DecisionOutput,
} from '../review/decide';
import type { ReviewDependencies } from '../review/review.shared';

/**
 * `seller-certificate.decline` (certification design 3.2, 7.2): Decline the pending submission (outcome
 * `declined`). See `decide` for the guards, the unit and the event. Rule: key
 * `certification.seller-certificate.approve` (protected), the admin population, not acting-as.
 */
export class DeclineSellerCertificate extends UseCase<
  DecisionInput,
  DecisionOutput,
  DecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-decline',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_APPROVE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: DecisionInput,
  ): Promise<Result<DecisionOutput, DecisionFailure>> {
    return decide(this.deps, context, input, 'declined');
  }
}
