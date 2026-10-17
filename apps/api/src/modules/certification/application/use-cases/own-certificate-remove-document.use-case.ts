import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import { isDraftEditable } from '../../domain/seller-certificate';
import {
  invalid,
  ownerOf,
  parseCertificateId,
  parseDocumentId,
  storeFailure,
  type OwnCertificateDependencies,
  type ValidationFailure,
} from '../own/own-certificate.shared';

export interface OwnCertificateRemoveDocumentInput {
  readonly certificateId: unknown;
  readonly documentId: unknown;
}

export type OwnCertificateRemoveDocumentFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.not-editable' }
  | { readonly code: 'document.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `own-certificate.remove-upload` (design 7.2): a seller takes a file off the draft. A file no
 * submission holds is deleted with its stored object and gives its bytes back to the quota; a
 * file a submission holds only leaves the draft (the submitted record keeps it). Rule: key
 * `certification.own-certificate.manage`.
 */
export class OwnCertificateRemoveDocument extends UseCase<
  OwnCertificateRemoveDocumentInput,
  { readonly removed: true },
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
  ): Promise<Result<{ readonly removed: true }, OwnCertificateRemoveDocumentFailure>> {
    const owner = ownerOf(context, { write: true });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const documentId = parseDocumentId(input.documentId);
    if (documentId === null) return invalid('documentId', 'format');

    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const discard: string[] = [];
    const removed = await deps.unitOfWork
      .run<true, OwnCertificateRemoveDocumentFailure>(market, async () => {
        const stored = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
        if (stored === null) return err({ code: 'certificate.not-found' } as const);
        if (!isDraftEditable(stored.status, stored.pendingSubmissionId)) {
          return err({ code: 'certificate.not-editable' } as const);
        }
        const documents = await deps.certificates.listDocuments(market, certificateId);
        const document = documents.find((candidate) => candidate.id === documentId);
        if (document === undefined) return err({ code: 'document.not-found' } as const);
        const outcome = await deps.certificates.removeDocument(
          market,
          certificateId,
          documentId,
          stored.version,
          now,
        );
        if (outcome === 'missing') return err({ code: 'document.not-found' } as const);
        if (outcome === 'deleted') {
          await deps.certificates.releaseQuota(market, owner.sellerId, document.byteSize, now);
          discard.push(document.objectKey);
        }
        return ok(true as const);
      })
      .catch((error: unknown) => storeFailure(context, 'certification.remove-document', error));
    if (!removed.ok) return removed;
    await Promise.all(discard.map((key) => deps.vault.discard(key).catch(() => undefined)));
    return ok({ removed: true });
  }
}
