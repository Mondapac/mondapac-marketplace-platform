import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  changeAgentAccountStatus,
  type AgentAccountStatusDependencies,
  type AgentAccountStatusFailure,
  type AgentAccountStatusInput,
  type AgentAccountStatusOutput,
} from '../agents/agent-account-status';

/**
 * Enables an agent account (ADR-0045 decision 5; see `changeAgentAccountStatus`). Rule
 * `own-resources` for an active admin; `agents.manage` is the `agents` module's rule, re-checked
 * on the caller's own actor in the serializable unit that writes.
 */
export class EnableAgentAccount extends UseCase<
  AgentAccountStatusInput,
  AgentAccountStatusOutput,
  AgentAccountStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.enable-agent-account',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AgentAccountStatusDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AgentAccountStatusInput,
  ): Promise<Result<AgentAccountStatusOutput, AgentAccountStatusFailure>> {
    return changeAgentAccountStatus(this.deps, context, input, 'active');
  }
}
