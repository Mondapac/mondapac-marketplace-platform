import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_EDIT } from '../../contracts/permissions';
import { ProductCertificationDocumentAddedAudit } from '../../domain/audit';
import { isProductDraftEditable } from '../../domain/product-certification';
import { MAX_DOCUMENTS_PER_CERTIFICATE } from '../../domain/seller-certificate';
import { MAX_DOCUMENT_BYTES, type DocumentRefusalCode } from '../intake/document-inspection';
import type { VaultedDocument } from '../ports/document-ports';
import type { StoredProductCertification } from '../ports/product-certification.repository';
import {
  adminOf,
  invalid,
  NOT_FOUND,
  parseProductCertificationId,
  productFailure,
  rootVersionIn,
  type ProductCertificationDependencies,
  type ProductDocumentOut,
  type ValidationFailure,
} from '../product/product-certification.shared';

export interface ProductCertificateUploadDocumentInput {
  readonly certificateId: unknown;
  /** The root's version the admin read. */
  readonly version: unknown;
  /** The file as standard base64 text; the type comes from the decoded content. */
  readonly data: unknown;
}

export interface ProductCertificateUploadDocumentOutput extends ProductDocumentOut {
  readonly certificateId: string;
  readonly version: number;
}

export type ProductCertificateUploadDocumentFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.not-editable' }
  | { readonly code: 'document.limit-reached' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: DocumentRefusalCode }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | ValidationFailure;

/** Seconds an admin is told to wait when the file intake queue is full (as the seller's). */
const INTAKE_BUSY_RETRY_SECONDS = 5;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const logger = new Logger('ProductCertificationDocuments');

type Room = { ok: true; root: StoredProductCertification } | { refusal: 'not-editable' | 'full' };

function roomIn(root: StoredProductCertification): Room {
  if (!isProductDraftEditable(root.status, root.pendingRevisionId)) {
    return { refusal: 'not-editable' };
  }
  if (root.draftDocuments.length >= MAX_DOCUMENTS_PER_CERTIFICATE) return { refusal: 'full' };
  return { ok: true, root };
}

/**
 * `product-certificate.upload` (certification design 3.4 row 1, 9.3; slice 15 part 2): an admin
 * adds a file to a manufacturer certificate's draft, through the seller path's intake (the type
 * from the content: JPEG, PNG, PDF; an image written again without metadata; a PDF with active
 * content, encryption or too many pages refused; a refused file is not stored). An accepted file is
 * `clean` at once (no scanner yet), encrypted with its own data key wrapped under the Market's
 * platform subject. At most 10 MiB a file and 10 files a draft. The draft must be open for edit
 * (no pending revision: a submitted file is sealed). The unit locks the root under the version
 * read, so the admin is recorded as an editor of the draft (AC 20) and the version moves. Rule:
 * key `certification.product-certificate.edit`, not acting-as.
 */
export class ProductCertificateUploadDocument extends UseCase<
  ProductCertificateUploadDocumentInput,
  ProductCertificateUploadDocumentOutput,
  ProductCertificateUploadDocumentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-upload-document',
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
    input: ProductCertificateUploadDocumentInput,
  ): Promise<
    Result<ProductCertificateUploadDocumentOutput, ProductCertificateUploadDocumentFailure>
  > {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseProductCertificationId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const version = rootVersionIn(input.version);
    if (!version.ok) return err(version.error);
    if (typeof input.data !== 'string' || input.data.length === 0) {
      return invalid('data', 'required');
    }
    if (input.data.length > Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4) {
      return err({ code: 'file.too-large' });
    }
    if (input.data.length % 4 !== 0 || !BASE64.test(input.data)) return invalid('data', 'format');

    const { deps } = this;
    const { market } = context;

    // 1. Cheap checks before the intake: the record is there, at the version read, open for
    // edit and has room. The write unit checks all of it again under the lock.
    const read = await deps.unitOfWork
      .run(market, async () => ok(await deps.products.get(market, certificateId)), {
        readOnly: true,
      })
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-upload.read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return NOT_FOUND;
    if (read.value.version !== version.value) return err({ code: 'conflict.stale' });
    const room = roomIn(read.value);
    if ('refusal' in room) {
      return err({
        code: room.refusal === 'full' ? 'document.limit-reached' : 'certificate.not-editable',
      });
    }

    // 2. The intake, then the encrypted object: outside any unit.
    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.length > MAX_DOCUMENT_BYTES) return err({ code: 'file.too-large' });
    const inspected = await deps.intake.inspect(bytes);
    if (!inspected.ok) {
      if (inspected.error.code === 'request.throttled') {
        return err({ code: 'request.throttled', retryAfterSeconds: INTAKE_BUSY_RETRY_SECONDS });
      }
      return err(inspected.error);
    }
    const file = inspected.value;
    const documentId = deps.ids.next<'UploadedDocument'>();
    let vaulted: VaultedDocument;
    try {
      vaulted = await deps.documents.seal(market, documentId, file.bytes);
    } catch (error) {
      return productFailure(context, 'certification.product-certificate-upload.seal', error);
    }

    // 3. One unit: lock first, check again, write the file, its draft link and the editor.
    const now = deps.clock.now();
    const written = await deps.unitOfWork
      .run<ProductCertificateUploadDocumentOutput, ProductCertificateUploadDocumentFailure>(
        market,
        async () => {
          await deps.products.lock(market, certificateId, version.value, now);
          const current = await deps.products.get(market, certificateId);
          if (current === null) return NOT_FOUND;
          const again = roomIn(current);
          if ('refusal' in again) {
            return err({
              code:
                again.refusal === 'full' ? 'document.limit-reached' : 'certificate.not-editable',
            } as const);
          }
          const position =
            current.draftDocuments.reduce((max, d) => Math.max(max, d.position), 0) + 1;
          await deps.products.addDocument(market, {
            certificateId,
            typeId: current.typeId,
            documentId,
            position,
            mediaType: file.mediaType,
            byteSize: file.bytes.length,
            pageCount: file.pageCount,
            objectKey: vaulted.objectKey,
            dataKeyEnvelope: vaulted.dataKeyEnvelope,
            cleanSha256: vaulted.cleanSha256,
            editorAccountId: admin.accountId,
            now,
          });
          await deps.audit.record(
            context,
            ProductCertificationDocumentAddedAudit.entry(certificateId, {
              after: {
                typeId: current.typeId,
                documentId,
                documents: current.draftDocuments.length + 1,
              },
            }),
          );
          return ok({
            certificateId,
            version: version.value + 1,
            documentId,
            position,
            mediaType: file.mediaType,
            byteSize: file.bytes.length,
            pageCount: file.pageCount,
            createdAt: now.toString(),
          });
        },
      )
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-upload.write', error),
      );
    if (!written.ok) {
      await deps.documents.discard(vaulted.objectKey).catch(() => undefined);
      return written;
    }
    logger.log({
      msg: 'certification.product-certificate.document-added',
      certificateId: certificateId as Id,
      documentId: documentId as Id,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return written;
  }
}
