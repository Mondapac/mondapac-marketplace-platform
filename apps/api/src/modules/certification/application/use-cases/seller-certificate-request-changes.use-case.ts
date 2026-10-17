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
 * `seller-certificate.request-changes` (certification design 3.2, 7.2): Ask the seller for changes (outcome
 * `changes-requested`). See `decide` for the guards, the unit and the event. Rule: key
 * `certification.seller-certificate.approve` (protected), the admin population, not acting-as.
 */
export class RequestChangesSellerCertificate extends UseCase<
  DecisionInput,
  DecisionOutput,
  DecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-request-changes',
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
    return decide(this.deps, context, input, 'changes-requested');
  }
}
