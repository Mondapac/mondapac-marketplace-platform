import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import { TypeCreatedAudit } from '../../domain/audit';
import { CertificationTypeActivated } from '../../domain/events';
import {
  approveTypeCreation,
  type ProposalProblem,
  type TypeCreationProblem,
} from '../../domain/registry';
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

export interface TypeApproveCreationInput {
  readonly typeId: unknown;
  readonly proposalId: unknown;
  /** The proposal's version the second admin read. */
  readonly version: unknown;
}

export interface TypeApproveCreationOutput {
  readonly typeId: string;
  readonly proposalId: string;
  readonly status: 'active';
  readonly typeVersion: number;
}

export type TypeApproveCreationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'proposal.not-found' }
  | { readonly code: 'conflict.stale' }
  | ProposalProblem
  | TypeCreationProblem
  | ValidationFailure;

/**
 * `type.approve-creation` (new-type design 2, 5; FE-091; H1): a second admin with
 * `certification.type.edit`, not the proposer (`review.second-admin-required`), makes a proposed
 * type active. The admin approves exactly what they read: a proposal the proposer has since
 * replaced (`superseded`, after an edit) or one whose type no longer points at the revision it was
 * based on answers `conflict.stale`, never `review.proposal-closed`. One unit: the status under
 * the type's version, the proposal `approved` under its version, audit `certification.type.created`,
 * and `certification-type-activated.v1`. Only that one event: the outbox keeps one event per
 * aggregate version, and the approval moves the version once; for a type that was never live the
 * activation itself says its terms are new (no `certification-type-revised.v1`; nothing consumes
 * either yet, FE-145). From here the type's claim terms are matched in every text of the Market.
 * Rule: key `certification.type.edit` (protected), not acting-as.
 */
export class TypeApproveCreation extends UseCase<
  TypeApproveCreationInput,
  TypeApproveCreationOutput,
  TypeApproveCreationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-approve-creation',
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
    input: TypeApproveCreationInput,
  ): Promise<Result<TypeApproveCreationOutput, TypeApproveCreationFailure>> {
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
      .run<TypeApproveCreationOutput, TypeApproveCreationFailure>(market, async () => {
        const proposal = await deps.registry.proposal(market, proposalId);
        if (
          proposal === null ||
          proposal.subject !== 'type-creation' ||
          proposal.subjectId !== typeId ||
          proposal.basedOnRevisionId === null
        ) {
          return err({ code: 'proposal.not-found' } as const);
        }
        const type = await deps.registry.typeOfAnyStatus(market, typeId);
        if (type === null) return err({ code: 'proposal.not-found' } as const);
        // An edit by the proposer replaced this proposal: what this admin read is not what
        // would go live.
        if (proposal.state === 'superseded') return err({ code: 'conflict.stale' } as const);
        const next = approveTypeCreation(type.status, proposal, admin.accountId);
        if (!next.ok) return err(next.error);
        if (proposal.version !== version.value) return err({ code: 'conflict.stale' } as const);
        if (type.publishedRevisionId !== proposal.basedOnRevisionId) {
          return err({ code: 'conflict.stale' } as const);
        }
        const revisionId = proposal.basedOnRevisionId as StoredTypeRevision['id'];
        // Lock order: the type row, then its proposal (as for the reactivation).
        await deps.registry.setTypeStatus(market, typeId, 'active', type.version);
        await deps.registry.closeProposal(market, {
          id: proposalId,
          expectedVersion: version.value,
          state: 'approved',
          decidedByAccountId: admin.accountId,
          decidedAt: now,
        });
        await deps.audit.record(
          context,
          TypeCreatedAudit.entry(typeId, { after: { proposalId, revisionId } }),
        );
        await deps.outbox.append(context, [
          CertificationTypeActivated.record({
            aggregateId: typeId,
            aggregateVersion: type.version + 1,
            occurredAt: now,
            payload: { typeId },
          }),
        ]);
        return ok({
          typeId,
          proposalId,
          status: 'active' as const,
          typeVersion: type.version + 1,
        });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.type-approve-creation', error),
      );
  }
}
