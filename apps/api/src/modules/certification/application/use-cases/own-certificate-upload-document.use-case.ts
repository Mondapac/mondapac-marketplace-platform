import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import { UNAPPROVED_UPLOAD_LIMITS, UPLOAD_LIMITS } from '../../domain/rate-limits';
import { draftEditVerdict, MAX_DOCUMENTS_PER_CERTIFICATE } from '../../domain/seller-certificate';
import { MAX_DOCUMENT_BYTES, type DocumentRefusalCode } from '../intake/document-inspection';
import type { VaultedDocument } from '../ports/document-ports';
import {
  invalid,
  ownerOf,
  parseCertificateId,
  logWithdrawnByEdit,
  parseWithdrawPending,
  reserveLimits,
  storeFailure,
  withdrawForEdit,
  type DocumentView,
  type EditWithdrawsFailure,
  type OwnCertificateDependencies,
  type RateFailure,
  type ValidationFailure,
} from '../own/own-certificate.shared';

export interface OwnCertificateUploadDocumentInput {
  readonly certificateId: unknown;
  /** The file as standard base64 text; the type comes from the decoded content. */
  readonly data: unknown;
  /** The seller confirmed that the change withdraws the pending submission (design 3.2 row 2). */
  readonly withdrawPending?: unknown;
}

/** The stored file, and the pending submission this upload withdrew (cause `edited`), or null. */
export interface UploadedDocumentView extends DocumentView {
  readonly withdrawnSubmissionId: string | null;
}

export type OwnCertificateUploadDocumentFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.not-editable' }
  | EditWithdrawsFailure
  | { readonly code: 'document.limit-reached' }
  | { readonly code: 'draft-quota.exceeded' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: DocumentRefusalCode }
  | RateFailure
  | ValidationFailure;

/** Seconds a seller is told to wait when the file intake queue is full. */
const INTAKE_BUSY_RETRY_SECONDS = 5;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * `own-certificate.upload` (design 7.2, 9.3, simplified): a seller adds a file to a certificate's
 * draft. The type comes from the content (JPEG, PNG, PDF), an image is written again without
 * metadata, a PDF with active content, encryption or too many pages is refused, and a refused file
 * is not stored. An accepted file is `clean` at once (no scanner yet), encrypted with its own data
 * key wrapped under the seller's key, and counted against the draft quota. Limits: 10 MiB a file,
 * 10 files a certificate, 30 uploads a day (10 for a seller not yet approved). While a submission
 * is pending this is withdraw by edit (design 3.2 row 2): refused with
 * `certificate.edit-withdraws-submission` before the file is read until the seller confirms with
 * `withdrawPending`, then the submission is withdrawn (cause `edited`) in the unit that adds the
 * file. Rule: key `certification.own-certificate.manage`; an acting-as session is refused.
 */
export class OwnCertificateUploadDocument extends UseCase<
  OwnCertificateUploadDocumentInput,
  UploadedDocumentView,
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
  ): Promise<Result<UploadedDocumentView, OwnCertificateUploadDocumentFailure>> {
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
    const withdrawConfirmed = parseWithdrawPending(input.withdrawPending);
    if (withdrawConfirmed === null) return invalid('withdrawPending', 'type');

    const { deps } = this;
    const { market } = context;

    // Cheap checks first, before any limit is spent: the certificate is the seller's, open for
    // edit (an edit of a pending submission needs the seller's confirmation) and has room. A refused
    // upload costs no attempt (Hassan L3); the write unit checks all of it again.
    const checked = await deps.unitOfWork
      .run<
        | { ok: true; typeId: Id<'CertificationType'> }
        | { refusal: OwnCertificateUploadDocumentFailure },
        never
      >(
        market,
        async () => ok(await this.#room(context, owner.sellerId, certificateId, withdrawConfirmed)),
        { readOnly: true },
      )
      .catch((error: unknown) => storeFailure(context, 'certification.upload.read', error));
    if (!checked.ok) return checked;
    if ('refusal' in checked.value) return err(checked.value.refusal);

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

    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.length > MAX_DOCUMENT_BYTES) return err({ code: 'file.too-large' });
    const inspected = await deps.intake.inspect(bytes);
    if (!inspected.ok) {
      // The intake is busy (its queue is full): the seller tries again shortly.
      if (inspected.error.code === 'request.throttled') {
        return err({ code: 'request.throttled', retryAfterSeconds: INTAKE_BUSY_RETRY_SECONDS });
      }
      return err(inspected.error);
    }
    const file = inspected.value;

    // The keyed index of the bytes (design 10.2), computed outside the unit with the other crypto.
    const indexHmac = deps.indexKeys.documentHmac(market, checked.value.typeId, file.bytes);
    const documentId = deps.ids.next<'UploadedDocument'>();
    const sealed = await this.#seal(context, owner.sellerId, documentId, file.bytes);
    if (!sealed.ok) return sealed;
    const vaulted = sealed.value;

    const now = deps.clock.now();
    const written = await deps.unitOfWork
      .run<UploadedDocumentView, OwnCertificateUploadDocumentFailure>(market, async () => {
        const stored = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
        if (stored === null) return err({ code: 'certificate.not-found' } as const);
        const verdict = draftEditVerdict(
          stored.status,
          stored.pendingSubmissionId,
          withdrawConfirmed,
        );
        if (verdict === 'closed') return err({ code: 'certificate.not-editable' } as const);
        if (verdict === 'confirm-withdraw') {
          return err({ code: 'certificate.edit-withdraws-submission' } as const);
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
        let version = stored.version;
        let withdrawnSubmissionId: string | null = null;
        if (verdict === 'withdraw-then-edit') {
          withdrawnSubmissionId = stored.pendingSubmissionId;
          version = await withdrawForEdit(deps, context, owner, stored, now);
        }
        const position =
          documents.reduce((max, document) => Math.max(max, document.position), 0) + 1;
        await deps.certificates.addDocument(market, {
          id: documentId,
          certificateId,
          expectedVersion: version,
          sellerId: owner.sellerId,
          typeId: stored.typeId,
          position,
          mediaType: file.mediaType,
          byteSize: file.bytes.length,
          pageCount: file.pageCount,
          objectKey: vaulted.objectKey,
          dataKeyEnvelope: vaulted.dataKeyEnvelope,
          cleanSha256: vaulted.cleanSha256,
          indexHmac,
          now,
        });
        return ok({
          documentId,
          position,
          mediaType: file.mediaType,
          byteSize: file.bytes.length,
          pageCount: file.pageCount,
          createdAt: now.toString(),
          withdrawnSubmissionId,
        });
      })
      .catch((error: unknown) => storeFailure(context, 'certification.upload.write', error));
    if (!written.ok) {
      await deps.vault.discard(vaulted.objectKey).catch(() => undefined);
      return written;
    }
    logWithdrawnByEdit(context, certificateId, written.value.withdrawnSubmissionId);
    return written;
  }

  async #room(
    context: CallContext,
    sellerId: Id<'Seller'>,
    certificateId: Id<'SellerCertification'>,
    withdrawConfirmed: boolean,
  ): Promise<
    { ok: true; typeId: Id<'CertificationType'> } | { refusal: OwnCertificateUploadDocumentFailure }
  > {
    const { market } = context;
    const { certificates } = this.deps;
    const stored = await certificates.findOwn(market, sellerId, certificateId);
    if (stored === null) return { refusal: { code: 'certificate.not-found' } };
    const verdict = draftEditVerdict(stored.status, stored.pendingSubmissionId, withdrawConfirmed);
    if (verdict === 'closed') return { refusal: { code: 'certificate.not-editable' } };
    if (verdict === 'confirm-withdraw') {
      return { refusal: { code: 'certificate.edit-withdraws-submission' } };
    }
    const documents = await certificates.listDocuments(market, certificateId);
    if (documents.length >= MAX_DOCUMENTS_PER_CERTIFICATE) {
      return { refusal: { code: 'document.limit-reached' } };
    }
    return { ok: true, typeId: stored.typeId };
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
