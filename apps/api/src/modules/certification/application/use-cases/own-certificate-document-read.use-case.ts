import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_VIEW } from '../../contracts/permissions';
import {
  invalid,
  ownerOf,
  parseCertificateId,
  parseDocumentId,
  storeFailure,
  type OwnCertificateDependencies,
  type ValidationFailure,
} from '../own/own-certificate.shared';

export interface OwnCertificateDocumentReadInput {
  readonly certificateId: unknown;
  readonly documentId: unknown;
}

export interface OwnCertificateDocumentReadOutput {
  readonly bytes: Buffer;
  /** The type found by inspection at upload, one of the three the intake accepts. */
  readonly contentType: 'image/jpeg' | 'image/png' | 'application/pdf';
  readonly position: number;
}

export type OwnCertificateDocumentReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'document.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `own-document.preview` (certification design 7.2, 9.4, simplified): the bytes of one file of the
 * seller's own certificate, decrypted under the seller's key. Only the owner reads a file in this
 * release (the reviewer's read comes with the review package). The key comes from the stored row,
 * never from the request; a file of another seller, a file of another certificate and an unknown
 * id answer one `document.not-found`. The route serves it as a download with `nosniff`.
 */
export class OwnCertificateDocumentRead extends UseCase<
  OwnCertificateDocumentReadInput,
  OwnCertificateDocumentReadOutput,
  OwnCertificateDocumentReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-document-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_OWN_CERTIFICATE_VIEW.key] },
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
    input: OwnCertificateDocumentReadInput,
  ): Promise<Result<OwnCertificateDocumentReadOutput, OwnCertificateDocumentReadFailure>> {
    const owner = ownerOf(context, { write: false });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const documentId = parseDocumentId(input.documentId);
    if (documentId === null) return invalid('documentId', 'format');

    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run(
        market,
        async () =>
          ok(
            await deps.certificates.findDocumentForRead(
              market,
              owner.sellerId,
              certificateId,
              documentId,
            ),
          ),
        { readOnly: true },
      )
      .catch((error: unknown) => storeFailure(context, 'certification.document-read', error));
    if (!read.ok) return read;
    const document = read.value;
    if (document === null) return err({ code: 'document.not-found' });
    try {
      const opened = await deps.vault.open(market, owner.sellerId, document);
      if (!opened.ok) return err({ code: 'access.denied' });
      if (opened.value === null) return err({ code: 'document.not-found' });
      return ok({
        bytes: opened.value,
        contentType: document.mediaType,
        position: document.position,
      });
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
