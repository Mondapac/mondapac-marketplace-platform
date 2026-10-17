import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_REVIEW } from '../../contracts/permissions';
import { ReviewDocumentDownloaded } from '../../domain/audit';
import { parseCertificateId, parseDocumentId } from '../own/own-certificate.shared';
import {
  invalid,
  reviewerOf,
  reviewFailure,
  type ReviewDependencies,
  type ValidationFailure,
} from '../review/review.shared';

export interface SellerCertificateReviewDocumentReadInput {
  readonly certificateId: unknown;
  readonly documentId: unknown;
}

export interface SellerCertificateReviewDocumentReadOutput {
  readonly bytes: Buffer;
  readonly contentType: 'image/jpeg' | 'image/png' | 'application/pdf';
}

export type SellerCertificateReviewDocumentReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'document.not-found' }
  | { readonly code: 'document.download-disabled' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `seller-certificate.review-document-read` (certification design 7.2, 9.4 simplified): the bytes
 * of one file of the submission under review, decrypted under the seller's key, for a reviewer.
 * Only a file the shown submission holds is served; the key comes from the stored row, never from
 * the request, and an unknown id, a file of another certificate and a file of another Market are
 * one `document.not-found`. Each read writes `certification.document.downloaded` before the
 * bytes leave; a refused row returns nothing. The route serves an attachment with `nosniff`, a
 * sandbox CSP and `no-store`. Off until the PDF scan hardening lands: while
 * `CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED` is not `true` the answer is
 * `document.download-disabled` and nothing is read. Rule: key
 * `certification.seller-certificate.review` and the admin population.
 */
export class SellerCertificateReviewDocumentRead extends UseCase<
  SellerCertificateReviewDocumentReadInput,
  SellerCertificateReviewDocumentReadOutput,
  SellerCertificateReviewDocumentReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-review-document-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerCertificateReviewDocumentReadInput,
  ): Promise<
    Result<SellerCertificateReviewDocumentReadOutput, SellerCertificateReviewDocumentReadFailure>
  > {
    if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const documentId = parseDocumentId(input.documentId);
    if (documentId === null) return invalid('documentId', 'format');
    const { deps } = this;
    if (!deps.documentDownloadEnabled) return err({ code: 'document.download-disabled' });

    const { market } = context;
    const read = await deps.unitOfWork
      .run(market, async () => ok(await deps.reviews.snapshot(market, certificateId)), {
        readOnly: true,
      })
      .catch((error: unknown) => reviewFailure(context, 'certification.review-document', error));
    if (!read.ok) return read;
    const snapshot = read.value;
    const document = snapshot?.submission?.documents.find((d) => d.id === documentId);
    if (snapshot === null || snapshot.submission === null || document === undefined) {
      return err({ code: 'document.not-found' });
    }
    const submissionId = snapshot.submission.id;

    let bytes: Buffer | null;
    try {
      const opened = await deps.vault.open(market, snapshot.certificate.sellerId, document);
      if (!opened.ok) return err({ code: 'access.denied' });
      bytes = opened.value;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (bytes === null) return err({ code: 'document.not-found' });

    const audited = await deps.unitOfWork
      .run(market, async () => {
        await deps.audit.record(
          context,
          ReviewDocumentDownloaded.entry(certificateId, {
            after: { submissionId, documentId },
          }),
        );
        return ok(undefined);
      })
      .catch((error: unknown) =>
        reviewFailure(context, 'certification.review-document.audit', error),
      );
    if (!audited.ok) return err({ code: 'access.unavailable' });
    return ok({ bytes, contentType: document.mediaType });
  }
}
