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
 * `issuer-proposal.withdraw` (certification design 3.5, 7.6; slice 12): the proposer withdraws
 * their own pending issuer reactivation; the issuer stays `closed-to-new`. Audit
 * `certification.relaxation-proposal.withdrawn`. Rule: key `certification.issuer.edit` (protected),
 * not acting-as.
 */
export class IssuerProposalWithdraw extends UseCase<
  CloseProposalInput,
  CloseProposalOutput,
  CloseProposalFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-proposal-withdraw',
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
      action: 'withdraw',
      subjects: ['issuer-reactivation'],
      parseSubjectId: parseRegistryIssuerId,
      msg: 'certification.issuer-proposal-withdraw',
    });
  }
}
