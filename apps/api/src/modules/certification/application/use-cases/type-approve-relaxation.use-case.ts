import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import { TypeRelaxationApprovedAudit } from '../../domain/audit';
import { CertificationTypeRevised } from '../../domain/events';
import { closeProposal, type ProposalProblem } from '../../domain/registry';
import { classifyTypeRevision } from '../../domain/type-revision';
import type { StoredTypeRevision } from '../ports/registry.repository';
import {
  adminOf,
  invalid,
  parseProposalId,
  parseTypeId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface TypeApproveRelaxationInput {
  readonly typeId: unknown;
  readonly proposalId: unknown;
  /** The proposal's version the second admin read. */
  readonly version: unknown;
}

export interface TypeApproveRelaxationOutput {
  readonly typeId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly state: 'approved';
  /** The type's version after the publication. */
  readonly typeVersion: number;
}

export type TypeApproveRelaxationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'proposal.not-found' }
  | { readonly code: 'conflict.stale' }
  | ProposalProblem
  | ValidationFailure;

/**
 * `type.approve-relaxation` (certification design 3.6, 7.2, 7.6; H1; the rule of Q3 and AC 20): a
 * second admin with `certification.type.edit`, who is not the proposer
 * (`review.second-admin-required`, also a CHECK on the row), publishes a pending relaxing revision.
 * One unit: the proposal `approved` under its version, the type's pointer moved under the type's
 * version, `certification.type.relaxation-approved`, `certification-type-revised.v1`. The base must
 * still be the published revision, else `conflict.stale`. Approved certificates keep their own
 * revision (AC 19). Rule: key `certification.type.edit` (protected), not acting-as.
 */
export class TypeApproveRelaxation extends UseCase<
  TypeApproveRelaxationInput,
  TypeApproveRelaxationOutput,
  TypeApproveRelaxationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-approve-relaxation',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_TYPE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TypeApproveRelaxationInput,
  ): Promise<Result<TypeApproveRelaxationOutput, TypeApproveRelaxationFailure>> {
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
      .run<TypeApproveRelaxationOutput, TypeApproveRelaxationFailure>(market, async () => {
        const proposal = await deps.registry.proposal(market, proposalId);
        if (
          proposal === null ||
          proposal.subject !== 'type-revision' ||
          proposal.subjectId !== typeId ||
          proposal.proposedRevisionId === null
        ) {
          return err({ code: 'proposal.not-found' } as const);
        }
        const closed = closeProposal(proposal, 'approve', admin.accountId);
        if (!closed.ok) return err(closed.error);
        if (proposal.version !== version.value) return err({ code: 'conflict.stale' } as const);
        const type = await deps.registry.type(market, typeId);
        if (type === null || type.publishedRevisionId !== proposal.basedOnRevisionId) {
          return err({ code: 'conflict.stale' } as const);
        }
        const revisionId = proposal.proposedRevisionId as StoredTypeRevision['id'];
        const based = await deps.registry.revision(market, type.publishedRevisionId);
        const proposed = await deps.registry.revision(market, revisionId);
        if (based === null || proposed === null) {
          throw new Error('certification proposal without its revisions');
        }
        await deps.registry.closeProposal(market, {
          id: proposalId,
          expectedVersion: version.value,
          state: 'approved',
          decidedByAccountId: admin.accountId,
          decidedAt: now,
        });
        await deps.registry.publishRevision(market, typeId, revisionId, type.version);
        const { claimTermsChanged } = classifyTypeRevision(based.content, proposed.content);
        await deps.audit.record(
          context,
          TypeRelaxationApprovedAudit.entry(typeId, { after: { proposalId, revisionId } }),
        );
        await deps.outbox.append(context, [
          CertificationTypeRevised.record({
            aggregateId: typeId,
            aggregateVersion: type.version + 1,
            occurredAt: now,
            payload: { typeId, revisionId, claimTermsChanged },
          }),
        ]);
        return ok({
          typeId,
          proposalId,
          revisionId,
          state: 'approved' as const,
          typeVersion: type.version + 1,
        });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.type-approve-relaxation', error),
      );
  }
}
