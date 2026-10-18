import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_CLAIM_POLICY_EDIT } from '../../contracts/permissions';
import { ClaimPolicyRelaxationApprovedAudit } from '../../domain/audit';
import { ClaimPolicyChanged } from '../../domain/events';
import { closeProposal, type ProposalProblem } from '../../domain/registry';
import type { ClaimPolicyDependencies } from '../registry/claim-policy.shared';
import {
  adminOf,
  invalid,
  parseProposalId,
  parseTypeId,
  registryFailure,
  versionIn,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface ClaimPolicyApproveRelaxationInput {
  readonly typeId: unknown;
  readonly proposalId: unknown;
  /** The proposal's version the second admin read. */
  readonly version: unknown;
}

export interface ClaimPolicyApproveRelaxationOutput {
  readonly typeId: string;
  readonly policyId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly state: 'approved';
  /** The policy's version after the publication. */
  readonly policyVersion: number;
}

export type ClaimPolicyApproveRelaxationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'proposal.not-found' }
  | { readonly code: 'conflict.stale' }
  | ProposalProblem
  | ValidationFailure;

/**
 * `claim-policy.approve-relaxation` (certification design 3.7, 7.2, 7.6; H1; the rule of Q3 and
 * AC 20): a second admin with `certification.claim-policy.edit`, who is not the proposer (the
 * revision's author; `review.second-admin-required`, also a CHECK on the row), publishes a pending
 * relaxing policy revision. One unit, lock first: the policy row under the version just read,
 * then the proposal and the base checked again; the pointer moves, the proposal is `approved`
 * under its version, `certification.claim-policy.relaxation-approved`, `claim-policy-changed.v1`.
 * A base that is no longer the published revision is `conflict.stale`. Rule: key
 * `certification.claim-policy.edit` (protected), not acting-as.
 */
export class ClaimPolicyApproveRelaxation extends UseCase<
  ClaimPolicyApproveRelaxationInput,
  ClaimPolicyApproveRelaxationOutput,
  ClaimPolicyApproveRelaxationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.claim-policy-approve-relaxation',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_CLAIM_POLICY_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ClaimPolicyDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ClaimPolicyApproveRelaxationInput,
  ): Promise<Result<ClaimPolicyApproveRelaxationOutput, ClaimPolicyApproveRelaxationFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const typeId = parseTypeId(input.typeId);
    if (typeId === null) return invalid('typeId', 'format');
    const proposalId = parseProposalId(input.proposalId);
    if (proposalId === null) return invalid('proposalId', 'format');
    const version = versionIn(input.version);
    if (!version.ok) return err(version.error);
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    return deps.unitOfWork
      .run<ClaimPolicyApproveRelaxationOutput, ClaimPolicyApproveRelaxationFailure>(
        market,
        async () => {
          const seen = await deps.policies.policyOfType(market, typeId);
          if (seen === null) return err({ code: 'proposal.not-found' } as const);
          // Lock first: the policy row, then every read below sees what committed before.
          await deps.policies.lockPolicy(market, seen.id, seen.version);
          const policy = await deps.policies.policyOfType(market, typeId);
          if (policy === null || policy.version !== seen.version) {
            return err({ code: 'conflict.stale' } as const);
          }
          const proposal = await deps.registry.proposal(market, proposalId);
          if (
            proposal === null ||
            proposal.subject !== 'claim-policy-revision' ||
            proposal.subjectId !== policy.id ||
            proposal.proposedRevisionId === null
          ) {
            return err({ code: 'proposal.not-found' } as const);
          }
          const closed = closeProposal(proposal, 'approve', admin.accountId);
          if (!closed.ok) return err(closed.error);
          if (proposal.version !== version.value) return err({ code: 'conflict.stale' } as const);
          if (policy.publishedRevisionId !== proposal.basedOnRevisionId) {
            return err({ code: 'conflict.stale' } as const);
          }
          const revisionId = proposal.proposedRevisionId as Id<'ClaimPolicyRevision'>;
          const revision = await deps.policies.revision(market, revisionId);
          if (revision === null || revision.policyId !== policy.id) {
            throw new Error('claim policy proposal without its revision');
          }
          // The proposer is the revision's author (data design 3.20, Hassan L-b).
          if (revision.authorAccountId !== proposal.proposerAccountId) {
            throw new Error('claim policy proposal and revision disagree on the author');
          }
          await deps.policies.publishRevision(market, policy.id, revisionId, policy.version);
          await deps.registry.closeProposal(market, {
            id: proposalId,
            expectedVersion: version.value,
            state: 'approved',
            decidedByAccountId: admin.accountId,
            decidedAt: now,
          });
          await deps.audit.record(
            context,
            ClaimPolicyRelaxationApprovedAudit.entry(policy.id, {
              after: { typeId, proposalId, revisionId },
            }),
          );
          await deps.outbox.append(context, [
            ClaimPolicyChanged.record({
              aggregateId: policy.id,
              aggregateVersion: policy.version + 1,
              occurredAt: now,
              payload: { policyId: policy.id, revisionId, typeId },
            }),
          ]);
          return ok({
            typeId,
            policyId: policy.id,
            proposalId,
            revisionId,
            state: 'approved' as const,
            policyVersion: policy.version + 1,
          });
        },
      )
      .catch((error: unknown) =>
        registryFailure(context, 'certification.claim-policy-approve-relaxation', error),
      );
  }
}
