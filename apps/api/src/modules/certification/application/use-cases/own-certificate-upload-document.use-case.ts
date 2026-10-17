import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import { UNAPPROVED_UPLOAD_LIMITS, UPLOAD_LIMITS } from '../../domain/rate-limits';
import { isDraftEditable, MAX_DOCUMENTS_PER_CERTIFICATE } from '../../domain/seller-certificate';
import { MAX_DOCUMENT_BYTES, type DocumentRefusalCode } from '../intake/document-inspection';
import type { VaultedDocument } from '../ports/document-ports';
import {
  invalid,
  ownerOf,
  parseCertificateId,
  reserveLimits,
  storeFailure,
  type DocumentView,
  type OwnCertificateDependencies,
  type RateFailure,
  type ValidationFailure,
} from '../own/own-certificate.shared';

export interface OwnCertificateUploadDocumentInput {
  readonly certificateId: unknown;
  /** The file as standard base64 text; the type comes from the decoded content. */
  readonly data: unknown;
}

export type OwnCertificateUploadDocumentFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.not-editable' }
  | { readonly code: 'document.limit-reached' }
  | { readonly code: 'draft-quota.exceeded' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: DocumentRefusalCode }
  | RateFailure
  | ValidationFailure;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * `own-certificate.upload` (design 7.2, 9.3, simplified): a seller adds a file to a certificate's
 * draft. The type comes from the content (JPEG, PNG, PDF), an image is written again without
 * metadata, a PDF with active content, encryption or too many pages is refused, and a refused file
 * is not stored. An accepted file is `clean` at once (no scanner yet), encrypted with its own data
 * key wrapped under the seller's key, and counted against the draft quota. Limits: 10 MiB a file,
 * 10 files a certificate, 30 uploads a day (10 for a seller not yet approved). Rule: key
 * `certification.own-certificate.manage`.
 */
export class OwnCertificateUploadDocument extends UseCase<
  OwnCertificateUploadDocumentInput,
  DocumentView,
  OwnCertificateUploadDocumentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-upload-document',
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
    input: OwnCertificateUploadDocumentInput,
  ): Promise<Result<DocumentView, OwnCertificateUploadDocumentFailure>> {
    const owner = ownerOf(context, { write: true });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    if (typeof input.data !== 'string' || input.data.length === 0)
      return invalid('data', 'required');
    if (input.data.length > Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4) {
      return err({ code: 'file.too-large' });
    }
    if (input.data.length % 4 !== 0 || !BASE64.test(input.data)) return invalid('data', 'format');

    const { deps } = this;
    const { market } = context;

    // Which upload limit applies: a seller with an approved revision has a zone (design 7.5).
    let approved: boolean;
    try {
      const zones = await deps.zones.zonesOf(context, [owner.sellerId]);
      approved = zones.get(owner.sellerId)?.zone != null;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const throttled = await reserveLimits(
      deps,
      context,
      (approved ? UPLOAD_LIMITS : UNAPPROVED_UPLOAD_LIMITS).map((limit) => ({
        limit,
        subject: owner.sellerId,
      })),
    );
    if (throttled !== null) return err(throttled);

    // Cheap checks first: the certificate is the seller's, open for edit and has room.
    const checked = await deps.unitOfWork
      .run<{ ok: true } | { refusal: OwnCertificateUploadDocumentFailure }, never>(
        market,
        async () => ok(await this.#room(context, owner.sellerId, certificateId)),
        { readOnly: true },
      )
      .catch((error: unknown) => storeFailure(context, 'certification.upload.read', error));
    if (!checked.ok) return checked;
    if ('refusal' in checked.value) return err(checked.value.refusal);

    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.length > MAX_DOCUMENT_BYTES) return err({ code: 'file.too-large' });
    const inspected = await deps.intake.inspect(bytes);
    if (!inspected.ok) return err(inspected.error);
    const file = inspected.value;

    const documentId = deps.ids.next<'UploadedDocument'>();
    const sealed = await this.#seal(context, owner.sellerId, documentId, file.bytes);
    if (!sealed.ok) return sealed;
    const vaulted = sealed.value;

    const now = deps.clock.now();
    const written = await deps.unitOfWork
      .run<DocumentView, OwnCertificateUploadDocumentFailure>(market, async () => {
        const stored = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
        if (stored === null) return err({ code: 'certificate.not-found' } as const);
        if (!isDraftEditable(stored.status, stored.pendingSubmissionId)) {
          return err({ code: 'certificate.not-editable' } as const);
        }
        const documents = await deps.certificates.listDocuments(market, certificateId);
        if (documents.length >= MAX_DOCUMENTS_PER_CERTIFICATE) {
          return err({ code: 'document.limit-reached' } as const);
        }
        const reserved = await deps.certificates.reserveQuota(
          market,
          owner.sellerId,
          file.bytes.length,
          deps.draftQuotaBytes,
          now,
        );
        if (!reserved) return err({ code: 'draft-quota.exceeded' } as const);
        const position =
          documents.reduce((max, document) => Math.max(max, document.position), 0) + 1;
        await deps.certificates.addDocument(market, {
          id: documentId,
          certificateId,
          expectedVersion: stored.version,
          sellerId: owner.sellerId,
          typeId: stored.typeId,
          position,
          mediaType: file.mediaType,
          byteSize: file.bytes.length,
          pageCount: file.pageCount,
          objectKey: vaulted.objectKey,
          dataKeyEnvelope: vaulted.dataKeyEnvelope,
          cleanSha256: vaulted.cleanSha256,
          now,
        });
        return ok({
          documentId,
          position,
          mediaType: file.mediaType,
          byteSize: file.bytes.length,
          pageCount: file.pageCount,
          createdAt: now.toString(),
        });
      })
      .catch((error: unknown) => storeFailure(context, 'certification.upload.write', error));
    if (!written.ok) {
      await deps.vault.discard(vaulted.objectKey).catch(() => undefined);
      return written;
    }
    return written;
  }

  async #room(
    context: CallContext,
    sellerId: Id<'Seller'>,
    certificateId: Id<'SellerCertification'>,
  ): Promise<{ ok: true } | { refusal: OwnCertificateUploadDocumentFailure }> {
    const { market } = context;
    const { certificates } = this.deps;
    const stored = await certificates.findOwn(market, sellerId, certificateId);
    if (stored === null) return { refusal: { code: 'certificate.not-found' } };
    if (!isDraftEditable(stored.status, stored.pendingSubmissionId)) {
      return { refusal: { code: 'certificate.not-editable' } };
    }
    const documents = await certificates.listDocuments(market, certificateId);
    if (documents.length >= MAX_DOCUMENTS_PER_CERTIFICATE) {
      return { refusal: { code: 'document.limit-reached' } };
    }
    return { ok: true };
  }

  async #seal(
    context: CallContext,
    sellerId: Id<'Seller'>,
    documentId: Id<'UploadedDocument'>,
    plain: Buffer,
  ): Promise<Result<VaultedDocument, OwnCertificateUploadDocumentFailure>> {
    try {
      const sealed = await this.deps.vault.seal(context.market, sellerId, documentId, plain);
      return sealed.ok ? sealed : err({ code: 'access.denied' });
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
