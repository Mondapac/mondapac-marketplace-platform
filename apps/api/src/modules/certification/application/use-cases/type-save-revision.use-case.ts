import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import { TypeRelaxationRequestedAudit, TypeRevisedAudit } from '../../domain/audit';
import { CertificationTypeRevised, RelaxationProposed } from '../../domain/events';
import { changeReasonIn } from '../../domain/registry';
import {
  classifyTypeRevision,
  publicationOf,
  typeRevisionDiff,
  validateTypeRevision,
  type TypeRelaxation,
  type TypeRevisionProblem,
} from '../../domain/type-revision';
import type { StoredType, StoredTypeRevision } from '../ports/registry.repository';
import {
  adminOf,
  invalid,
  parseTypeId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';
import { typeRevisionContentIn } from '../registry/type-content';

export interface TypeSaveRevisionInput {
  readonly typeId: unknown;
  /** The type's version the admin read. */
  readonly version: unknown;
  readonly content: unknown;
  /** Optional, at most 500 characters; stored only encrypted on the revision (design 3.7). */
  readonly reason?: unknown;
}

export type TypeSaveRevisionOutput =
  | {
      readonly outcome: 'published';
      readonly typeId: string;
      readonly revisionId: string;
      readonly revisionNo: number;
      readonly version: number;
      readonly claimTermsChanged: boolean;
    }
  | {
      readonly outcome: 'pending-second-admin';
      readonly typeId: string;
      readonly revisionId: string;
      readonly revisionNo: number;
      readonly proposalId: string;
      /** The type is unchanged until the approval. */
      readonly version: number;
      readonly relaxations: readonly TypeRelaxation[];
    };

export type TypeSaveRevisionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'type.not-found' }
  | { readonly code: 'type.revision-unchanged' }
  | { readonly code: 'review.proposal-pending' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'type.revision-invalid';
      readonly issues: readonly TypeRevisionProblem[];
    }
  | ValidationFailure;

const logger = new Logger('CertificationTypeRevision');

/**
 * `types.save-revision` (certification design 3.6; CERT-01; AC 19; H1): a save is a new revision,
 * never an edit. The content passes `validateTypeRevision` against the Market's supported locales
 * and the published revision (`verificationMode` never changes). A revision that relaxes nothing
 * is published in the same unit (`certification-type-revised.v1`, audit `.type.revised`). One
 * that relaxes a setting, removes a claim term or drops a locale is saved and a `type-revision`
 * proposal is written `pending` (audit `.type.relaxation-requested`, `relaxation-proposed.v1`):
 * it is published only when a second admin approves it. While one is pending, every save is
 * refused (`review.proposal-pending`, design 7.6). The optional reason is sealed under its own
 * key, the revision id, inside the unit (CE8). Approved certificates keep their own revision, so
 * no certificate's status or badge text changes (AC 19). Rule: key `certification.type.edit`
 * (protected), the admin population, not acting-as.
 */
export class TypeSaveRevision extends UseCase<
  TypeSaveRevisionInput,
  TypeSaveRevisionOutput,
  TypeSaveRevisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-save-revision',
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
    input: TypeSaveRevisionInput,
  ): Promise<Result<TypeSaveRevisionOutput, TypeSaveRevisionFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const typeId = parseTypeId(input.typeId);
    if (typeId === null) return invalid('typeId', 'format');
    const version = versionIn(input.version);
    if (!version.ok) return err(version.error);
    const reason = changeReasonIn(input.reason);
    if (!reason.ok) return invalid('reason', reason.code);

    const { deps } = this;
    const { market } = context;

    // 1. The type and its published revision, to validate and classify against.
    const read = await deps.unitOfWork
      .run<{ type: StoredType; published: StoredTypeRevision } | null, never>(
        market,
        async () => {
          const type = await deps.registry.type(market, typeId);
          if (type === null) return ok(null);
          const published = await deps.registry.revision(market, type.publishedRevisionId);
          if (published === null) throw new Error('certification type without its revision');
          return ok({ type, published });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        registryFailure(context, 'certification.type-save-revision.read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'type.not-found' });
    const { type, published } = read.value;
    if (type.version !== version.value) return err({ code: 'conflict.stale' });

    const parsed = typeRevisionContentIn(input.content, type.verificationMode);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems });
    const checked = validateTypeRevision(
      parsed.value,
      deps.supportedLocales(market),
      published.content,
    );
    if (!checked.ok) return err({ code: 'type.revision-invalid', issues: checked.error });
    const content = checked.value;
    if (typeRevisionDiff(published.content, content).length === 0) {
      return err({ code: 'type.revision-unchanged' });
    }
    const classification = classifyTypeRevision(published.content, content);
    const publication = publicationOf(classification);

    // 2. One unit: the revision, its reason, then the pointer or the proposal.
    const now = deps.clock.now();
    const revisionId = deps.ids.next<'CertificationTypeRevision'>();
    const proposalId = deps.ids.next<'RelaxationProposal'>();
    const result = await deps.unitOfWork
      .run<TypeSaveRevisionOutput, TypeSaveRevisionFailure>(market, async () => {
        const current = await deps.registry.type(market, typeId);
        if (current === null) return err({ code: 'type.not-found' } as const);
        if (current.version !== version.value || current.publishedRevisionId !== published.id) {
          return err({ code: 'conflict.stale' } as const);
        }
        if ((await deps.registry.pendingProposal(market, 'type-revision', typeId)) !== null) {
          return err({ code: 'review.proposal-pending' } as const);
        }
        const reasonCiphertext =
          reason.value === null
            ? null
            : await deps.cipher.sealChangeReason(market, revisionId, reason.value);
        const revisionNo = await deps.registry.addRevision(market, {
          id: revisionId,
          typeId,
          content,
          authorAccountId: admin.accountId,
          changeReasonCiphertext: reasonCiphertext,
          createdAt: now,
        });

        if (publication === 'publish-now') {
          await deps.registry.publishRevision(market, typeId, revisionId, version.value);
          await deps.audit.record(
            context,
            TypeRevisedAudit.entry(typeId, {
              after: {
                revisionId,
                claimTermsChanged: classification.claimTermsChanged,
                reasonGiven: reasonCiphertext !== null,
              },
            }),
          );
          await deps.outbox.append(context, [
            CertificationTypeRevised.record({
              aggregateId: typeId,
              aggregateVersion: version.value + 1,
              occurredAt: now,
              payload: {
                typeId,
                revisionId,
                claimTermsChanged: classification.claimTermsChanged,
              },
            }),
          ]);
          return ok({
            outcome: 'published' as const,
            typeId,
            revisionId,
            revisionNo,
            version: version.value + 1,
            claimTermsChanged: classification.claimTermsChanged,
          });
        }

        const refused = await deps.registry.addProposal(market, {
          id: proposalId,
          subject: 'type-revision',
          subjectId: typeId,
          basedOnRevisionId: published.id,
          proposedRevisionId: revisionId,
          proposedExpertReferenceCiphertext: null,
          proposerAccountId: admin.accountId,
          // The reason of a revision lives on the revision (design 3.7).
          changeReasonCiphertext: null,
          proposedAt: now,
        });
        if (refused !== null) return err({ code: refused } as const);
        await deps.audit.record(
          context,
          TypeRelaxationRequestedAudit.entry(typeId, {
            after: { proposalId, revisionId, reasonGiven: reasonCiphertext !== null },
          }),
        );
        await deps.outbox.append(context, [
          RelaxationProposed.record({
            aggregateId: proposalId,
            aggregateVersion: 1,
            occurredAt: now,
            payload: { proposalId, subject: 'type-revision' },
          }),
        ]);
        return ok({
          outcome: 'pending-second-admin' as const,
          typeId,
          revisionId,
          revisionNo,
          proposalId,
          version: version.value,
          relaxations: classification.relaxations,
        });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.type-save-revision.write', error),
      );
    if (result.ok) {
      logger.log({
        msg: 'certification.type-revision.saved',
        outcome: result.value.outcome,
        typeId,
        revisionId: result.value.revisionId as Id,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return result;
  }
}
