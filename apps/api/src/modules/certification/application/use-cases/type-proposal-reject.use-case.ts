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
 * `type-proposal.reject` (certification design 7.2, 7.6; slice 12): an admin who is not the
 * proposer rejects a pending type proposal (a relaxing revision or a reactivation); the type stays
 * as it was and the revision is never published. Audit `certification.relaxation-proposal.rejected`.
 * Rule: key `certification.type.edit` (protected), not acting-as.
 */
export class TypeProposalReject extends UseCase<
  CloseProposalInput,
  CloseProposalOutput,
  CloseProposalFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-proposal-reject',
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
      action: 'reject',
      subjects: ['type-revision', 'type-reactivation'],
      parseSubjectId: parseTypeId,
      msg: 'certification.type-proposal-reject',
    });
  }
}
