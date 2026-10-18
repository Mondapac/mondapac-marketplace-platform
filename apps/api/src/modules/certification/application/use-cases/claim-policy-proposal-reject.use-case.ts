import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_CLAIM_POLICY_EDIT } from '../../contracts/permissions';
import { closePolicyProposal, type ClaimPolicyDependencies } from '../registry/claim-policy.shared';
import type {
  CloseProposalFailure,
  CloseProposalInput,
  CloseProposalOutput,
} from '../registry/close-proposal';

/**
 * `claim-policy-proposal.reject` (certification design 3.7, 7.2, 7.6; slice 13): an admin who is not the proposer rejects the pending policy relaxation; the policy stays as it was and the revision is never published. Audit `certification.relaxation-proposal.rejected`.
 * The subject id of the input is the type id. Rule: key `certification.claim-policy.edit`
 * (protected), not acting-as.
 */
export class ClaimPolicyProposalReject extends UseCase<
  CloseProposalInput,
  CloseProposalOutput,
  CloseProposalFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.claim-policy-proposal-reject',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_CLAIM_POLICY_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ClaimPolicyDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CloseProposalInput,
  ): Promise<Result<CloseProposalOutput, CloseProposalFailure>> {
    return closePolicyProposal(
      this.deps,
      context,
      input,
      'reject',
      'certification.claim-policy-proposal-reject',
    );
  }
}
