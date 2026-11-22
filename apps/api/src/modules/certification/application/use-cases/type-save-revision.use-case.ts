import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import {
  TypeProposalRevisedAudit,
  TypeRelaxationRequestedAudit,
  TypeRevisedAudit,
} from '../../domain/audit';
import { CertificationTypeRevised, RelaxationProposed } from '../../domain/events';
import { changeReasonIn, isClosedTypeStatus } from '../../domain/registry';
import {
  assertSecondAdmin,
  classifyTypeRevision,
  publicationOf,
  typeRevisionDiff,
  validateTypeRevision,
  type TypeRelaxation,
  type TypeRevisionContent,
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
import {
  CERTIFICATION_REVIEW_AREA,
  requestRef,
  revisionValues,
  TYPE_REVISION_SUBJECT_KIND,
  type CertificationRequestRef,
} from '../registry/certification-review';
import { typeRevisionContentIn } from '../registry/type-content';

export interface TypeSaveRevisionInput {
  readonly typeId: unknown;
  /** The type's version the admin read. */
  readonly version: unknown;
  readonly content: unknown;
  /** Optional, at most 500 characters; stored only encrypted on the revision (design 3.7). */
  readonly reason?: unknown;
  /**
   * The admin's note for the reviewer (Admin Inbox › System requests, area certification): 1 to
   * 500 characters, needed only when the save is published while the Market reviews the area.
   */
  readonly note?: unknown;
}

export type TypeSaveRevisionOutput =
  | {
      readonly outcome: 'published';
      readonly typeId: string;
      readonly revisionId: string;
      readonly revisionNo: number;
      readonly version: number;
      readonly claimTermsChanged: boolean;
      /** The review this publication opened; null when the Market does not review the area. */
      readonly request: CertificationRequestRef;
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
      /** Always null: nothing is live yet; the second admin's approval is the check. */
      readonly request: null;
    }
  | {
      /** The proposer changed their proposed type (FE-091); a second admin approves the new one. */
      readonly outcome: 'proposal-revised';
      readonly typeId: string;
      readonly revisionId: string;
      readonly revisionNo: number;
      /** The new pending `type-creation` proposal; the earlier one is `superseded`. */
      readonly proposalId: string;
      readonly proposalVersion: number;
      readonly version: number;
      readonly request: null;
    };

export type TypeSaveRevisionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'type.not-found' }
  | { readonly code: 'type.revision-unchanged' }
  | { readonly code: 'review.proposal-pending' }
  | { readonly code: 'review.not-proposer' }
  | { readonly code: 'type.proposal-closed' }
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
 * refused (`review.proposal-pending`, design 7.6), as is every save while a `type-reactivation`
 * proposal is pending. The optional reason is sealed under its own
 * key, the revision id, inside the unit (CE8). Approved certificates keep their own revision, so
 * no certificate's status or badge text changes (AC 19). A published revision opens its review
 * in Admin Inbox › System requests in the same unit (area certification; the `note` is checked
 * there and a refusal rolls the save back); a pending one opens none. A `proposed` type (FE-091)
 * is changed only by its proposer (`review.not-proposer`): the revision is published on the
 * proposed type at once, its pending `type-creation` proposal is `superseded` and a new one is
 * written, so a second admin's approval of the earlier content answers `conflict.stale`; nothing
 * is live and nothing is reviewed in System requests. A rejected or withdrawn type refuses every
 * save (`type.proposal-closed`). Rule: key
 * `certification.type.edit` (protected), the admin population, not acting-as.
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
          const type = await deps.registry.typeOfAnyStatus(market, typeId);
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
    if (isClosedTypeStatus(type.status)) return err({ code: 'type.proposal-closed' });
    if (type.version !== version.value) return err({ code: 'conflict.stale' });

    const parsed = typeRevisionContentIn(input.content, type.verificationMode);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems });
    const checked = validateTypeRevision(
      parsed.value,
      deps.supportedLocales(market),
      published.content,
      deps.badgeArtworkKeys,
    );
    if (!checked.ok) return err({ code: 'type.revision-invalid', issues: checked.error });
    const content = checked.value;
    const diff = typeRevisionDiff(published.content, content);
    if (diff.length === 0) return err({ code: 'type.revision-unchanged' });
    if (type.status === 'proposed') {
      return this.reviseProposal(context, admin.accountId, {
        typeId,
        version: version.value,
        published,
        content,
        reason: reason.value,
      });
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
        // A relaxing save does not move the type's pointer, so it locks the row itself before
        // the pending-proposal check: it then serialises with a revert of the same type (which
        // locks the row first, too), and neither sees the other half done. A publish-now save
        // takes the same lock when it moves the pointer under the version guard.
        if (publication !== 'publish-now') {
          await deps.registry.lockType(market, typeId, version.value);
        }
        if ((await deps.registry.pendingProposal(market, 'type-revision', typeId)) !== null) {
          return err({ code: 'review.proposal-pending' } as const);
        }
        // A pending reactivation was proposed on the published revision: a new revision would
        // change what the second admin approves (design 5), so the save waits for its decision.
        if ((await deps.registry.pendingProposal(market, 'type-reactivation', typeId)) !== null) {
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
          // The publication is live; its review opens in the same unit, under the type's row
          // lock the publication took (a refusal, such as a missing note, rolls it all back).
          const review = await deps.review.openReview(context, {
            area: CERTIFICATION_REVIEW_AREA,
            subjectKind: TYPE_REVISION_SUBJECT_KIND,
            subjectRef: typeId,
            before: revisionValues({ id: published.id, revisionNo: published.revisionNo }),
            after: revisionValues(
              { id: revisionId, revisionNo },
              diff.map((entry) => entry.path),
            ),
            note: input.note,
          });
          if (!review.ok) return err(review.error);
          return ok({
            outcome: 'published' as const,
            typeId,
            revisionId,
            revisionNo,
            version: version.value + 1,
            claimTermsChanged: classification.claimTermsChanged,
            request: requestRef(review.value),
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
          request: null,
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

  /** The proposer's edit of their proposed type (FE-091): see the class comment. */
  private async reviseProposal(
    context: CallContext,
    accountId: Id<'Account'>,
    save: {
      readonly typeId: Id<'CertificationType'>;
      readonly version: number;
      readonly published: StoredTypeRevision;
      readonly content: TypeRevisionContent;
      readonly reason: string | null;
    },
  ): Promise<Result<TypeSaveRevisionOutput, TypeSaveRevisionFailure>> {
    const { deps } = this;
    const { market } = context;
    const { typeId } = save;
    const now = deps.clock.now();
    const revisionId = deps.ids.next<'CertificationTypeRevision'>();
    const proposalId = deps.ids.next<'RelaxationProposal'>();
    return deps.unitOfWork
      .run<TypeSaveRevisionOutput, TypeSaveRevisionFailure>(market, async () => {
        const current = await deps.registry.typeOfAnyStatus(market, typeId);
        if (current === null) return err({ code: 'type.not-found' } as const);
        if (isClosedTypeStatus(current.status)) {
          return err({ code: 'type.proposal-closed' } as const);
        }
        if (
          current.status !== 'proposed' ||
          current.version !== save.version ||
          current.publishedRevisionId !== save.published.id
        ) {
          return err({ code: 'conflict.stale' } as const);
        }
        // Lock order: the type row, then its proposal.
        await deps.registry.lockType(market, typeId, save.version);
        const pending = await deps.registry.pendingProposal(market, 'type-creation', typeId);
        if (pending === null) throw new Error('a proposed certification type without its proposal');
        if (assertSecondAdmin(pending.proposerAccountId, accountId).ok) {
          return err({ code: 'review.not-proposer' } as const);
        }
        const revisionNo = await deps.registry.addRevision(market, {
          id: revisionId,
          typeId,
          content: save.content,
          authorAccountId: accountId,
          changeReasonCiphertext: null,
          createdAt: now,
        });
        await deps.registry.publishRevision(market, typeId, revisionId, save.version);
        await deps.registry.closeProposal(market, {
          id: pending.id,
          expectedVersion: pending.version,
          state: 'superseded',
          decidedByAccountId: null,
          decidedAt: now,
        });
        // The reason given with the edit is the new proposal's, sealed under its own key (CE8).
        const reasonCiphertext =
          save.reason === null
            ? null
            : await deps.cipher.sealChangeReason(market, proposalId, save.reason);
        const refused = await deps.registry.addProposal(market, {
          id: proposalId,
          subject: 'type-creation',
          subjectId: typeId,
          basedOnRevisionId: revisionId,
          proposedRevisionId: null,
          proposedExpertReferenceCiphertext: null,
          proposerAccountId: accountId,
          changeReasonCiphertext: reasonCiphertext,
          proposedAt: now,
        });
        if (refused !== null)
          throw new Error('a superseded type-creation proposal is still pending');
        await deps.audit.record(
          context,
          TypeProposalRevisedAudit.entry(typeId, {
            after: {
              proposalId,
              supersededProposalId: pending.id,
              revisionId,
              revisionNo,
              reasonGiven: reasonCiphertext !== null,
            },
          }),
        );
        // No `relaxation-proposed.v1` for a type-creation proposal (see PROPOSAL_SUBJECTS).
        return ok({
          outcome: 'proposal-revised' as const,
          typeId,
          revisionId,
          revisionNo,
          proposalId,
          proposalVersion: 1,
          version: save.version + 1,
          request: null,
        });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.type-save-revision.proposal', error),
      );
  }
}
