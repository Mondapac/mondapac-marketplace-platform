import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import {
  closeSubjectProposal,
  type CloseProposalFailure,
  type CloseProposalInput,
  type CloseProposalOutput,
} from '../registry/close-proposal';
import { parseTypeId, type RegistryDependencies } from '../registry/registry.shared';

/**
 * `type-proposal.withdraw` (certification design 7.2, 7.6; slice 12): the proposer withdraws
 * their own pending type proposal; the type stays as it was. Audit
 * `certification.relaxation-proposal.withdrawn`. Rule: key `certification.type.edit` (protected),
 * not acting-as.
 */
export class TypeProposalWithdraw extends UseCase<
  CloseProposalInput,
  CloseProposalOutput,
  CloseProposalFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-proposal-withdraw',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_TYPE_EDIT.key] },
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
      subjects: ['type-revision', 'type-reactivation'],
      parseSubjectId: parseTypeId,
      msg: 'certification.type-proposal-withdraw',
    });
  }
}
