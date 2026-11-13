import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  demoteApprovals,
  type CultureDemoteApprovalsDependencies,
  type CultureDemoteApprovalsFailure,
  type CultureDemoteApprovalsInput,
  type CultureDemoteApprovalsResult,
} from './culture-demote-approvals.use-case';

/**
 * `sellers.culture-demote-approvals-system`: the same for the system actor, the handler of
 * `catalog.culture-approvals-invalidated.v1` (ADR-0048 security review N1).
 */
export class CultureDemoteApprovalsSystem extends UseCase<
  CultureDemoteApprovalsInput,
  CultureDemoteApprovalsResult,
  CultureDemoteApprovalsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.culture-demote-approvals-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CultureDemoteApprovalsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CultureDemoteApprovalsInput,
  ): Promise<Result<CultureDemoteApprovalsResult, CultureDemoteApprovalsFailure>> {
    return demoteApprovals(this.deps, context, input);
  }
}
