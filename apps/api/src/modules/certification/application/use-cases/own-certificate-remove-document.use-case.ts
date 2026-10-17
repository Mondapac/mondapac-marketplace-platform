import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import { draftEditVerdict } from '../../domain/seller-certificate';
import {
  invalid,
  ownerOf,
  parseCertificateId,
  parseDocumentId,
  parseWithdrawPending,
  storeFailure,
  withdrawForEdit,
  type EditWithdrawsFailure,
  type OwnCertificateDependencies,
  type ValidationFailure,
} from '../own/own-certificate.shared';

export interface OwnCertificateRemoveDocumentInput {
  readonly certificateId: unknown;
  readonly documentId: unknown;
  /** The seller confirmed that the change withdraws the pending submission (design 3.2 row 2). */
  readonly withdrawPending?: unknown;
}

export interface OwnCertificateRemoveDocumentOutput {
  readonly removed: true;
  /** The pending submission this change withdrew (cause `edited`), or null. */
  readonly withdrawnSubmissionId: string | null;
}

export type OwnCertificateRemoveDocumentFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.not-editable' }
  | EditWithdrawsFailure
  | { readonly code: 'document.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `own-certificate.remove-upload` (design 7.2): a seller takes a file off the draft. A file no
 * submission holds is deleted with its stored object and gives its bytes back to the quota; a
 * file a submission holds only leaves the draft (the submitted record keeps it). While a submission
 * is pending this is withdraw by edit (design 3.2 row 2): refused with
 * `certificate.edit-withdraws-submission` until the seller confirms with `withdrawPending`, then
 * the submission is withdrawn (cause `edited`) in the same unit, before the file leaves the draft.
 * Rule: key `certification.own-certificate.manage`; an acting-as session is refused.
 */
export class OwnCertificateRemoveDocument extends UseCase<
  OwnCertificateRemoveDocumentInput,
  OwnCertificateRemoveDocumentOutput,
  OwnCertificateRemoveDocumentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-remove-document',
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
    input: OwnCertificateRemoveDocumentInput,
  ): Promise<Result<OwnCertificateRemoveDocumentOutput, OwnCertificateRemoveDocumentFailure>> {
    const owner = ownerOf(context, { write: true });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const documentId = parseDocumentId(input.documentId);
    if (documentId === null) return invalid('documentId', 'format');
    const withdrawConfirmed = parseWithdrawPending(input.withdrawPending);
    if (withdrawConfirmed === null) return invalid('withdrawPending', 'type');

    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const discard: string[] = [];
    const removed = await deps.unitOfWork
      .run<string | null, OwnCertificateRemoveDocumentFailure>(market, async () => {
        const stored = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
        if (stored === null) return err({ code: 'certificate.not-found' } as const);
        const verdict = draftEditVerdict(
          stored.status,
          stored.pendingSubmissionId,
          withdrawConfirmed,
        );
        if (verdict === 'closed') return err({ code: 'certificate.not-editable' } as const);
        const documents = await deps.certificates.listDocuments(market, certificateId);
        const document = documents.find((candidate) => candidate.id === documentId);
        if (document === undefined) return err({ code: 'document.not-found' } as const);
        if (verdict === 'confirm-withdraw') {
          return err({ code: 'certificate.edit-withdraws-submission' } as const);
        }
        let version = stored.version;
        let withdrawn: string | null = null;
        if (verdict === 'withdraw-then-edit') {
          withdrawn = stored.pendingSubmissionId;
          version = await withdrawForEdit(deps, context, owner, stored, now);
        }
        const outcome = await deps.certificates.removeDocument(
          market,
          certificateId,
          documentId,
          version,
          now,
        );
        if (outcome === 'missing') return err({ code: 'document.not-found' } as const);
        if (outcome === 'deleted') {
          await deps.certificates.releaseQuota(market, owner.sellerId, document.byteSize, now);
          discard.push(document.objectKey);
        }
        return ok(withdrawn);
      })
      .catch((error: unknown) => storeFailure(context, 'certification.remove-document', error));
    if (!removed.ok) return removed;
    await Promise.all(discard.map((key) => deps.vault.discard(key).catch(() => undefined)));
    return ok({ removed: true, withdrawnSubmissionId: removed.value });
  }
}
