import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import { DRAFT_SAVE_LIMITS } from '../../domain/rate-limits';
import {
  draftEditVerdict,
  isDraftEditable,
  parseDraftContent,
  sameDraftContent,
  type DraftContent,
} from '../../domain/seller-certificate';
import {
  invalid,
  ownerOf,
  parseCertificateId,
  parseWithdrawPending,
  reserveLimits,
  storeFailure,
  summaryOf,
  withdrawForEdit,
  type CertificateSummary,
  type EditWithdrawsFailure,
  type OwnCertificateDependencies,
  type RateFailure,
  type ValidationFailure,
} from '../own/own-certificate.shared';
import type { StoredDraft } from '../ports/seller-certificate.repository';

type DraftFault = 'type' | 'not-applicable' | 'unknown' | 'not-selectable';

export interface OwnCertificateSaveDraftInput {
  readonly certificateId: unknown;
  /** The whole draft: every field present, `null` clears it. */
  readonly draft: unknown;
  /**
   * The seller confirmed that a change to a field the pending submission holds withdraws it
   * (design 3.2 row 2). Absent or false: such a change is refused with
   * `certificate.edit-withdraws-submission` and nothing is written.
   */
  readonly withdrawPending?: unknown;
}

/** The draft as the seller gets it back: dates as local dates, the texts in clear. */
export interface DraftView {
  readonly issuerId: string | null;
  readonly certificateNumber: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  readonly selfDeclared: boolean | null;
  readonly selfDeclarationNote: string | null;
}

export function draftViewOf(draft: DraftContent): DraftView {
  return {
    issuerId: draft.issuerId,
    certificateNumber: draft.certificateNumber,
    issueDate: draft.issueDate === null ? null : draft.issueDate.toString(),
    expiryDate: draft.expiryDate === null ? null : draft.expiryDate.toString(),
    selfDeclared: draft.selfDeclared,
    selfDeclarationNote: draft.selfDeclarationNote,
  };
}

export interface OwnCertificateSaveDraftOutput {
  readonly certificate: CertificateSummary;
  readonly draft: DraftView;
  /** The pending submission this save withdrew (cause `edited`), or null. */
  readonly withdrawnSubmissionId: string | null;
}

export type OwnCertificateSaveDraftFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.not-editable' }
  | EditWithdrawsFailure
  | { readonly code: 'conflict.stale' }
  | RateFailure
  | ValidationFailure;

/**
 * `own-certificate.save-draft` (design 3.1, 7.2): the seller replaces the working copy of a
 * certificate: the issuer from the registry of the same type and Market, the certificate number
 * and the self-declaration note (both encrypted under the seller's key), the issue and expiry
 * local dates and the self-declaration tick. Spends one save of the account's limits. While a
 * submission is pending (first review, correction or renewal), a save that changes a value is
 * withdraw by edit (design 3.2 row 2, slice 8): refused with `certificate.edit-withdraws-submission`
 * until the seller confirms with `withdrawPending`, then the submission is withdrawn (cause
 * `edited`) and the draft written in one unit and one version step; the approved submission of a
 * renewal stays valid and untouched. A save that changes nothing while pending writes nothing.
 * Rule: key `certification.own-certificate.manage`; an acting-as session is refused; a
 * certificate of another seller is the same `certificate.not-found` as an unknown id.
 */
export class OwnCertificateSaveDraft extends UseCase<
  OwnCertificateSaveDraftInput,
  OwnCertificateSaveDraftOutput,
  OwnCertificateSaveDraftFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-save-draft',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_OWN_CERTIFICATE_MANAGE.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnCertificateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnCertificateSaveDraftInput,
  ): Promise<Result<OwnCertificateSaveDraftOutput, OwnCertificateSaveDraftFailure>> {
    const owner = ownerOf(context, { write: true });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const parsed = parseDraftContent(input.draft);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.error });
    const draft = parsed.value;
    const withdrawConfirmed = parseWithdrawPending(input.withdrawPending);
    if (withdrawConfirmed === null) return invalid('withdrawPending', 'type');

    const { deps } = this;
    const throttled = await reserveLimits(
      deps,
      context,
      DRAFT_SAVE_LIMITS.map((limit) => ({ limit, subject: owner.accountId })),
    );
    if (throttled !== null) return err(throttled);

    const { market } = context;
    const read = await deps.unitOfWork
      .run<
        { stored: Awaited<ReturnType<typeof deps.certificates.findOwn>>; fault: DraftFault | null },
        never
      >(
        market,
        async () => {
          const stored = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
          if (stored === null) return ok({ stored, fault: null });
          const type = await deps.types.typeById(market, stored.typeId);
          if (type === null) return ok({ stored, fault: 'type' as const });
          if (draft.issuerId !== null) {
            if (!type.requiresIssuerRegistry) return ok({ stored, fault: 'not-applicable' });
            const issuer = await deps.types.issuer(market, draft.issuerId);
            if (issuer === null || issuer.typeId !== stored.typeId) {
              return ok({ stored, fault: 'unknown' });
            }
            if (issuer.state !== 'active') return ok({ stored, fault: 'not-selectable' });
          }
          return ok({ stored, fault: null });
        },
        { readOnly: true },
      )
      .catch((error: unknown) => storeFailure(context, 'certification.save-draft.read', error));
    if (!read.ok) return read;
    const { stored, fault } = read.value;
    if (stored === null) return err({ code: 'certificate.not-found' });
    if (fault === 'type') return err({ code: 'access.unavailable' });
    if (fault !== null) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'issuerId', code: fault }],
      });
    }
    const verdict = draftEditVerdict(stored.status, stored.pendingSubmissionId, withdrawConfirmed);
    if (verdict === 'closed') return err({ code: 'certificate.not-editable' });
    if (verdict !== 'edit') {
      // A pending submission holds the stored draft's values: an unchanged save is no edit.
      const unchanged = await this.#sameAsStored(context, owner.sellerId, stored.draft, draft);
      if (!unchanged.ok) return unchanged;
      if (unchanged.value) {
        return ok({
          certificate: summaryOf(stored, false, this.deps.clock.now()),
          draft: draftViewOf(draft),
          withdrawnSubmissionId: null,
        });
      }
      if (verdict === 'confirm-withdraw') {
        return err({ code: 'certificate.edit-withdraws-submission' });
      }
    }

    const number =
      draft.certificateNumber === null
        ? ok(null)
        : await deps.cipher.seal(
            market,
            owner.sellerId,
            'draft-certificate-number',
            draft.certificateNumber,
          );
    if (!number.ok) return err({ code: 'access.denied' });
    const note =
      draft.selfDeclarationNote === null
        ? ok(null)
        : await deps.cipher.seal(
            market,
            owner.sellerId,
            'draft-self-declaration-note',
            draft.selfDeclarationNote,
          );
    if (!note.ok) return err({ code: 'access.denied' });

    const now = deps.clock.now();
    const sealed: StoredDraft = {
      issuerId: draft.issuerId,
      certificateNumberCiphertext: number.value,
      issueDate: draft.issueDate,
      expiryDate: draft.expiryDate,
      selfDeclared: draft.selfDeclared,
      selfDeclarationNoteCiphertext: note.value,
    };
    const withdrawn = verdict === 'withdraw-then-edit' ? stored.pendingSubmissionId : null;
    const written = await deps.unitOfWork
      .run<CertificateSummary, OwnCertificateSaveDraftFailure>(market, async () => {
        if (withdrawn !== null) {
          // The version guard refuses a record that moved since the read: a reviewer's decision
          // or another edit makes this `conflict.stale`, never a withdrawal of the wrong one.
          await withdrawForEdit(deps, context, owner, stored, now, sealed);
        } else {
          await deps.certificates.saveDraft(market, certificateId, stored.version, sealed, now);
        }
        const saved = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
        if (saved === null) throw new Error('save-draft: the certificate vanished');
        return ok(summaryOf(saved, isDraftEditable(saved.status, saved.pendingSubmissionId), now));
      })
      .catch((error: unknown) => storeFailure(context, 'certification.save-draft.write', error));
    if (!written.ok) return written;
    return ok({
      certificate: written.value,
      draft: draftViewOf(draft),
      withdrawnSubmissionId: withdrawn,
    });
  }

  /** Whether the new draft equals the stored one; the stored texts are opened to compare. */
  async #sameAsStored(
    context: CallContext,
    sellerId: Id<'Seller'>,
    stored: StoredDraft,
    draft: DraftContent,
  ): Promise<Result<boolean, OwnCertificateSaveDraftFailure>> {
    const { market } = context;
    const { cipher } = this.deps;
    const number =
      stored.certificateNumberCiphertext === null
        ? ok(null)
        : await cipher.open(
            market,
            sellerId,
            'draft-certificate-number',
            stored.certificateNumberCiphertext,
          );
    if (!number.ok) return err({ code: 'access.denied' });
    const note =
      stored.selfDeclarationNoteCiphertext === null
        ? ok(null)
        : await cipher.open(
            market,
            sellerId,
            'draft-self-declaration-note',
            stored.selfDeclarationNoteCiphertext,
          );
    if (!note.ok) return err({ code: 'access.denied' });
    return ok(
      sameDraftContent(draft, {
        issuerId: stored.issuerId,
        certificateNumber: number.value,
        issueDate: stored.issueDate,
        expiryDate: stored.expiryDate,
        selfDeclared: stored.selfDeclared,
        selfDeclarationNote: note.value,
      }),
    );
  }
}
