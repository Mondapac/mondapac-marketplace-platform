import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_EDIT } from '../../contracts/permissions';
import { ProductCertificationDocumentRemovedAudit } from '../../domain/audit';
import { isProductDraftEditable } from '../../domain/product-certification';
import {
  adminOf,
  invalid,
  NOT_FOUND,
  parseDocumentId,
  parseProductCertificationId,
  productFailure,
  rootVersionIn,
  type ProductCertificationDependencies,
  type ValidationFailure,
} from '../product/product-certification.shared';

export interface ProductCertificateRemoveDocumentInput {
  readonly certificateId: unknown;
  readonly documentId: unknown;
  /** The root's version the admin read. */
  readonly version: unknown;
}

export interface ProductCertificateRemoveDocumentOutput {
  readonly certificateId: string;
  readonly documentId: string;
  /** True when no revision held the file, so it was deleted with its stored object. */
  readonly deleted: boolean;
  readonly version: number;
}

export type ProductCertificateRemoveDocumentFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.not-editable' }
  | { readonly code: 'document.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

const logger = new Logger('ProductCertificationDocuments');

/**
 * `product-certificate.remove-upload` (certification design 3.4 row 1; slice 15 part 2): an admin
 * takes a file off a manufacturer certificate's draft. A file no revision holds is deleted with its
 * stored object; a file a revision holds only leaves the draft (the revision keeps it: sealed at
 * submission). The draft must be open for edit (no pending revision). The unit locks the root
 * under the version read and records the admin as an editor of the draft (AC 20). Rule: key
 * `certification.product-certificate.edit`, not acting-as.
 */
export class ProductCertificateRemoveDocument extends UseCase<
  ProductCertificateRemoveDocumentInput,
  ProductCertificateRemoveDocumentOutput,
  ProductCertificateRemoveDocumentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-remove-document',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductCertificateRemoveDocumentInput,
  ): Promise<
    Result<ProductCertificateRemoveDocumentOutput, ProductCertificateRemoveDocumentFailure>
  > {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseProductCertificationId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const documentId = parseDocumentId(input.documentId);
    if (documentId === null) return invalid('documentId', 'format');
    const version = rootVersionIn(input.version);
    if (!version.ok) return err(version.error);

    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const discard: string[] = [];
    const result = await deps.unitOfWork
      .run<ProductCertificateRemoveDocumentOutput, ProductCertificateRemoveDocumentFailure>(
        market,
        async () => {
          await deps.products.lock(market, certificateId, version.value, now);
          const current = await deps.products.get(market, certificateId);
          if (current === null) return NOT_FOUND;
          if (!isProductDraftEditable(current.status, current.pendingRevisionId)) {
            return err({ code: 'certificate.not-editable' } as const);
          }
          const document = current.draftDocuments.find((d) => d.id === documentId);
          if (document === undefined) return err({ code: 'document.not-found' } as const);
          const outcome = await deps.products.removeDocument(market, {
            certificateId,
            documentId,
            editorAccountId: admin.accountId,
            now,
          });
          if (outcome === 'missing') return err({ code: 'document.not-found' } as const);
          const deleted = outcome === 'deleted';
          if (deleted) discard.push(document.objectKey);
          await deps.audit.record(
            context,
            ProductCertificationDocumentRemovedAudit.entry(certificateId, {
              after: { typeId: current.typeId, documentId, deleted },
            }),
          );
          return ok({ certificateId, documentId, deleted, version: version.value + 1 });
        },
      )
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-remove-document', error),
      );
    if (!result.ok) return result;
    // After the commit: a failed delete of the object leaves an orphan, never a dangling row.
    await Promise.all(discard.map((key) => deps.documents.discard(key).catch(() => undefined)));
    logger.log({
      msg: 'certification.product-certificate.document-removed',
      certificateId: certificateId as Id,
      documentId: documentId as Id,
      deleted: result.value.deleted,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
