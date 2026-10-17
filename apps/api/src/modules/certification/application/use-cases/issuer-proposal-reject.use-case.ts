import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import {
  closeSubjectProposal,
  type CloseProposalFailure,
  type CloseProposalInput,
  type CloseProposalOutput,
} from '../registry/close-proposal';
import { parseRegistryIssuerId, type RegistryDependencies } from '../registry/registry.shared';

/**
 * `issuer-proposal.reject` (certification design 3.5, 7.6; slice 12): an admin who is not the
 * proposer rejects a pending issuer reactivation; the issuer stays `closed-to-new`. Audit
 * `certification.relaxation-proposal.rejected`. Rule: key `certification.issuer.edit` (protected),
 * not acting-as.
 */
export class IssuerProposalReject extends UseCase<
  CloseProposalInput,
  CloseProposalOutput,
  CloseProposalFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-proposal-reject',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CloseProposalInput,
  ): Promise<Result<CloseProposalOutput, CloseProposalFailure>> {
    return closeSubjectProposal(this.deps, context, input, {
      action: 'reject',
      subjects: ['issuer-reactivation'],
      parseSubjectId: parseRegistryIssuerId,
      msg: 'certification.issuer-proposal-reject',
    });
  }
}
