import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import { TypeReactivationApprovedAudit } from '../../domain/audit';
import { CertificationTypeActivated } from '../../domain/events';
import {
  reactivateType,
  type ProposalProblem,
  type TypeStatusProblem,
} from '../../domain/registry';
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

export interface TypeApproveReactivationInput {
  readonly typeId: unknown;
  readonly proposalId: unknown;
  /** The proposal's version the second admin read. */
  readonly version: unknown;
}

export interface TypeApproveReactivationOutput {
  readonly typeId: string;
  readonly proposalId: string;
  readonly status: 'active';
  readonly typeVersion: number;
}

export type TypeApproveReactivationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'proposal.not-found' }
  | { readonly code: 'conflict.stale' }
  | ProposalProblem
  | TypeStatusProblem
  | ValidationFailure;

/**
 * `type.approve-reactivation` (certification design 3.6, 7.2; H1): a second admin with
 * `certification.type.edit`, not the proposer (`review.second-admin-required`), makes an inactive
 * type active again. One unit: the proposal `approved` under its version, the status under the
 * type's version, `certification.type.reactivation-approved`, `certification-type-activated.v1`.
 * Activation of a type for sellers (Kosher, Vegan; Q1) is this transition. Rule: key
 * `certification.type.edit` (protected), not acting-as.
 */
export class TypeApproveReactivation extends UseCase<
  TypeApproveReactivationInput,
  TypeApproveReactivationOutput,
  TypeApproveReactivationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-approve-reactivation',
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
    input: TypeApproveReactivationInput,
  ): Promise<Result<TypeApproveReactivationOutput, TypeApproveReactivationFailure>> {
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
      .run<TypeApproveReactivationOutput, TypeApproveReactivationFailure>(market, async () => {
        const proposal = await deps.registry.proposal(market, proposalId);
        if (
          proposal === null ||
          proposal.subject !== 'type-reactivation' ||
          proposal.subjectId !== typeId
        ) {
          return err({ code: 'proposal.not-found' } as const);
        }
        const type = await deps.registry.type(market, typeId);
        if (type === null) return err({ code: 'proposal.not-found' } as const);
        const next = reactivateType(type.status, proposal, admin.accountId);
        if (!next.ok) return err(next.error);
        if (proposal.version !== version.value) return err({ code: 'conflict.stale' } as const);
        // Lock order: the type row, then its proposal (as for issuers).
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
          TypeReactivationApprovedAudit.entry(typeId, { after: { proposalId } }),
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
        registryFailure(context, 'certification.type-approve-reactivation', error),
      );
  }
}
