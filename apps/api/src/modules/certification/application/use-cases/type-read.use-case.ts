import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_VIEW } from '../../contracts/permissions';
import type { TypeStatus } from '../../domain/registry';
import type { TypeRevisionContent } from '../../domain/type-revision';
import type { ChangeReasonRead } from '../ports/registry-cipher';
import type { StoredProposal, StoredType, StoredTypeRevision } from '../ports/registry.repository';
import {
  adminOf,
  invalid,
  parseTypeId,
  proposalView,
  registryFailure,
  type RegistryDependencies,
  type RelaxationProposalView,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface TypeReadInput {
  readonly typeId: unknown;
}

export interface TypeReadOutput {
  readonly typeId: string;
  readonly code: string;
  readonly status: TypeStatus;
  readonly version: number;
  readonly published: {
    readonly revisionId: string;
    readonly revisionNo: number;
    readonly content: TypeRevisionContent;
    readonly authorAccountId: string;
    readonly createdAt: string;
    readonly reason: ChangeReasonRead | null;
  };
  /** A relaxing revision waiting for a second admin (design 3.6, 7.6). */
  readonly pendingRevision: RelaxationProposalView | null;
  /** A reactivation of this inactive type waiting for a second admin (H1). */
  readonly pendingReactivation: RelaxationProposalView | null;
}

export type TypeReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'type.not-found' }
  | ValidationFailure;

interface Snapshot {
  readonly type: StoredType;
  readonly published: StoredTypeRevision;
  readonly revision: StoredProposal | null;
  readonly proposedRevision: StoredTypeRevision | null;
  readonly reactivation: StoredProposal | null;
}

/**
 * `types.read` (certification design 3.6, 7.2, 7.6; slice 12): one type with its published
 * revision (settings, names, descriptions, claim terms per locale) and its pending proposals with
 * the diff a second admin approves and the actions the reader may take. The change reasons are
 * opened outside the unit; a destroyed reason key shows `erased`. Rule: key
 * `certification.type.view`, the admin population.
 */
export class TypeRead extends UseCase<TypeReadInput, TypeReadOutput, TypeReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_TYPE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TypeReadInput,
  ): Promise<Result<TypeReadOutput, TypeReadFailure>> {
    const admin = adminOf(context, { write: false });
    if (admin === null) return err({ code: 'access.denied' });
    const typeId = parseTypeId(input?.typeId);
    if (typeId === null) return invalid('typeId', 'format');
    const { market } = context;
    const { deps } = this;
    const read = await deps.unitOfWork
      .run<Snapshot | null, never>(
        market,
        async () => {
          const type = await deps.registry.type(market, typeId);
          if (type === null) return ok(null);
          const published = await deps.registry.revision(market, type.publishedRevisionId);
          if (published === null) throw new Error('certification type without its revision');
          const revision = await deps.registry.pendingProposal(market, 'type-revision', typeId);
          const proposedRevision =
            revision?.proposedRevisionId == null
              ? null
              : await deps.registry.revision(
                  market,
                  revision.proposedRevisionId as StoredTypeRevision['id'],
                );
          const reactivation = await deps.registry.pendingProposal(
            market,
            'type-reactivation',
            typeId,
          );
          return ok({ type, published, revision, proposedRevision, reactivation });
        },
        { readOnly: true },
      )
      .catch((error: unknown) => registryFailure(context, 'certification.type-read', error));
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'type.not-found' });
    const { type, published, revision, proposedRevision, reactivation } = read.value;
    try {
      const reason =
        published.changeReasonCiphertext === null
          ? null
          : await deps.cipher.openChangeReason(
              market,
              published.id,
              published.changeReasonCiphertext,
            );
      const based = { based: published, proposed: proposedRevision };
      return ok({
        typeId: type.id,
        code: type.code,
        status: type.status,
        version: type.version,
        published: {
          revisionId: published.id,
          revisionNo: published.revisionNo,
          content: published.content,
          authorAccountId: published.authorAccountId,
          createdAt: published.createdAt.toString(),
          reason,
        },
        pendingRevision:
          revision === null
            ? null
            : await proposalView(deps, market, revision, admin.accountId, based),
        pendingReactivation:
          reactivation === null
            ? null
            : await proposalView(deps, market, reactivation, admin.accountId, {
                based: null,
                proposed: null,
              }),
      });
    } catch (error) {
      return registryFailure(context, 'certification.type-read.reason', error);
    }
  }
}
