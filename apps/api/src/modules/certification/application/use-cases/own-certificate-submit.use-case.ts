import { canonicalJson, err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import { SellerCertificationSubmitted } from '../../domain/events';
import { SUBMIT_LIMITS } from '../../domain/rate-limits';
import {
  expiryBoundaryIn,
  incompleteFields,
  submissionContentOf,
  submissionKindFor,
  SUBMISSION_CONTENT_SCHEMA_VERSION,
  type DraftContent,
  type SubmissionKind,
  type TypeSettings,
} from '../../domain/seller-certificate';
import { isUsableZone } from '../../domain/validity';
import {
  invalid,
  ownerOf,
  parseCertificateId,
  reserveLimits,
  storeFailure,
  type OwnCertificateDependencies,
  type RateFailure,
  type ValidationFailure,
} from '../own/own-certificate.shared';
import type { IssuerChoice } from '../ports/certificate-type-catalog';
import type { StoredCertificate, StoredDocument } from '../ports/seller-certificate.repository';

export interface OwnCertificateSubmitInput {
  readonly certificateId: unknown;
}

export interface OwnCertificateSubmitOutput {
  readonly certificateId: string;
  readonly submissionId: string;
  readonly kind: SubmissionKind;
  readonly submittedAt: string;
}

export type OwnCertificateSubmitFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.has-pending-submission' }
  | { readonly code: 'certificate.not-submittable' }
  | {
      readonly code: 'certificate.incomplete';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'issuer.not-active' }
  | { readonly code: 'certificate.expired' }
  | { readonly code: 'seller.zone-missing' }
  | { readonly code: 'conflict.stale' }
  | RateFailure
  | ValidationFailure;

interface Snapshot {
  readonly stored: StoredCertificate;
  readonly documents: readonly StoredDocument[];
  readonly type: TypeSettings | null;
  readonly issuer: IssuerChoice | null;
}

/**
 * `own-certificate.submit` (certification design 3.2 row 1): the draft becomes an immutable
 * submission for review. Guards: the record has no pending submission and is `draft`,
 * `changes-needed`, `approved` or `expired` (kind `initial`, `resubmission`, `renewal`); the draft
 * is complete for the type revision in force (issuer from the registry when required, number,
 * expiry date, at least one file when required, the tick for a self-declaration); every file is
 * clean and the seller's own (by construction of the draft links); the issuer is `active` and of
 * the same type; the expiry boundary in the seller's zone is after now. The submission keeps the
 * content, the files in order and a keyed content hash; the record goes `in-review` (a renewal
 * keeps its `approved` or `expired` status with the pending pointer), one history row and the
 * event `seller-certification-submitted.v1` are written in the same unit. Files that join a
 * submission for the first time leave the draft quota. Five submissions per certificate a day.
 * Rule: key `certification.own-certificate.manage`; an acting-as session is refused.
 */
export class OwnCertificateSubmit extends UseCase<
  OwnCertificateSubmitInput,
  OwnCertificateSubmitOutput,
  OwnCertificateSubmitFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-submit',
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
    input: OwnCertificateSubmitInput,
  ): Promise<Result<OwnCertificateSubmitOutput, OwnCertificateSubmitFailure>> {
    const owner = ownerOf(context, { write: true });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');

    const { deps } = this;
    const { market } = context;
    const throttled = await reserveLimits(
      deps,
      context,
      SUBMIT_LIMITS.map((limit) => ({ limit, subject: certificateId })),
    );
    if (throttled !== null) return err(throttled);

    // 1. Read what the guards need in one snapshot.
    const read = await deps.unitOfWork
      .run<Snapshot | null, never>(
        market,
        async () => {
          const stored = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
          if (stored === null) return ok(null);
          const documents = await deps.certificates.listDocuments(market, certificateId);
          const type = await deps.types.typeById(market, stored.typeId);
          const issuer =
            stored.draft.issuerId === null
              ? null
              : await deps.types.issuer(market, stored.draft.issuerId);
          return ok({ stored, documents, type, issuer });
        },
        { readOnly: true },
      )
      .catch((error: unknown) => storeFailure(context, 'certification.submit.read', error));
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'certificate.not-found' });
    const { stored, documents, type, issuer } = read.value;
    if (type === null) return err({ code: 'access.unavailable' });
    if (stored.pendingSubmissionId !== null) {
      return err({ code: 'certificate.has-pending-submission' });
    }
    const kind = submissionKindFor(stored.status, stored.pendingSubmissionId);
    if (kind === null) return err({ code: 'certificate.not-submittable' });

    // 2. The draft in clear, and whether it is complete for the type revision in force.
    const number =
      stored.draft.certificateNumberCiphertext === null
        ? ok(null)
        : await deps.cipher.open(
            market,
            owner.sellerId,
            'draft-certificate-number',
            stored.draft.certificateNumberCiphertext,
          );
    if (!number.ok) return err({ code: 'access.denied' });
    const note =
      stored.draft.selfDeclarationNoteCiphertext === null
        ? ok(null)
        : await deps.cipher.open(
            market,
            owner.sellerId,
            'draft-self-declaration-note',
            stored.draft.selfDeclarationNoteCiphertext,
          );
    if (!note.ok) return err({ code: 'access.denied' });
    const draft: DraftContent = {
      issuerId: stored.draft.issuerId,
      certificateNumber: number.value,
      issueDate: stored.draft.issueDate,
      expiryDate: stored.draft.expiryDate,
      selfDeclared: stored.draft.selfDeclared,
      selfDeclarationNote: note.value,
    };
    const missing = incompleteFields(type, draft, documents.length);
    if (missing.length > 0) return err({ code: 'certificate.incomplete', fields: missing });
    const content = submissionContentOf(type, draft);

    // 3. The issuer must be active and of this type (a registry type only).
    if (type.requiresIssuerRegistry && type.verificationMode !== 'SELF_DECLARATION') {
      if (issuer === null || issuer.typeId !== stored.typeId || issuer.state !== 'active') {
        return err({ code: 'issuer.not-active' });
      }
    }

    // 4. The seller's zone, and an expiry boundary after now (no already-expired certificate).
    const now = deps.clock.now();
    let zones;
    try {
      zones = await deps.zones.zonesOf(context, [owner.sellerId]);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const zone = zones.get(owner.sellerId);
    const sellerZone = zone?.zone ?? null;
    const addressZone = zone?.addressZone ?? null;
    if (
      sellerZone === null ||
      addressZone === null ||
      !isUsableZone(sellerZone) ||
      !isUsableZone(addressZone)
    ) {
      return err({ code: 'seller.zone-missing' });
    }
    if (content.expiryDate !== null) {
      const boundary = [
        expiryBoundaryIn(content.expiryDate, sellerZone),
        expiryBoundaryIn(content.expiryDate, addressZone),
      ].reduce((a, b) => (Temporal.Instant.compare(a, b) <= 0 ? a : b));
      if (Temporal.Instant.compare(boundary, now) <= 0) return err({ code: 'certificate.expired' });
    }

    // 5. Seal the submission's text and hash the content (outside the unit: no crypto inside).
    const sealedNumber =
      content.certificateNumber === null
        ? ok(null)
        : await deps.cipher.seal(
            market,
            owner.sellerId,
            'submission-certificate-number',
            content.certificateNumber,
          );
    if (!sealedNumber.ok) return err({ code: 'access.denied' });
    const sealedNote =
      content.selfDeclarationNote === null
        ? ok(null)
        : await deps.cipher.seal(
            market,
            owner.sellerId,
            'submission-self-declaration-note',
            content.selfDeclarationNote,
          );
    if (!sealedNote.ok) return err({ code: 'access.denied' });
    const canonical = canonicalJson({
      schemaVersion: SUBMISSION_CONTENT_SCHEMA_VERSION,
      typeRevisionId: type.revisionId,
      issuerId: content.issuerId,
      certificateNumber: content.certificateNumber,
      issueDate: content.issueDate === null ? null : content.issueDate.toString(),
      expiryDate: content.expiryDate === null ? null : content.expiryDate.toString(),
      selfDeclared: content.selfDeclared,
      selfDeclarationNote: content.selfDeclarationNote,
      documents: documents.map((document) => document.cleanSha256.toString('hex')),
    });
    if (!canonical.ok) return err({ code: 'access.unavailable' });
    const hashed = await deps.cipher.hash(market, owner.sellerId, canonical.value);
    if (!hashed.ok) return err({ code: 'access.denied' });

    // 6. One unit: re-read by version, write the submission, its files, the root, the history
    // row and the event.
    const submissionId = deps.ids.next<'Submission'>();
    const historyId = deps.ids.next<'CertificationHistory'>();
    const toStatus =
      stored.status === 'draft' || stored.status === 'changes-needed' ? 'in-review' : stored.status;
    const unsubmittedBytes = documents
      .filter((document) => !document.submitted)
      .reduce((sum, document) => sum + document.byteSize, 0);
    const written = await deps.unitOfWork
      .run<OwnCertificateSubmitOutput, OwnCertificateSubmitFailure>(market, async () => {
        const current = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
        if (current === null) return err({ code: 'certificate.not-found' } as const);
        if (current.version !== stored.version) return err({ code: 'conflict.stale' } as const);
        await deps.certificates.submit(market, {
          certificateId,
          expectedVersion: stored.version,
          sellerId: owner.sellerId,
          typeId: stored.typeId,
          typeRevisionId: type.revisionId,
          submissionId,
          submissionNo: stored.submissionCount + 1,
          kind,
          issuerId: content.issuerId,
          certificateNumberCiphertext: sealedNumber.value,
          issueDate: content.issueDate,
          expiryDate: content.expiryDate,
          selfDeclared: content.selfDeclared,
          selfDeclarationNoteCiphertext: sealedNote.value,
          contentSchemaVersion: SUBMISSION_CONTENT_SCHEMA_VERSION,
          contentHash: `hmac-sha256:${hashed.value}`,
          submittedZone: sellerZone,
          submittedAt: now,
          submittedByAccountId: owner.accountId,
          documentIds: documents.map((document) => document.id),
          fromStatus: stored.status,
          toStatus,
          historyId,
        });
        if (unsubmittedBytes > 0) {
          await deps.certificates.releaseQuota(market, owner.sellerId, unsubmittedBytes, now);
        }
        await deps.outbox.append(context, [
          SellerCertificationSubmitted.record({
            aggregateId: certificateId,
            aggregateVersion: stored.version + 1,
            occurredAt: now,
            payload: {
              sellerCertificationId: certificateId,
              sellerId: owner.sellerId,
              submissionId,
              kind,
            },
          }),
        ]);
        return ok({
          certificateId,
          submissionId,
          kind,
          submittedAt: now.toString(),
        });
      })
      .catch((error: unknown) => storeFailure(context, 'certification.submit.write', error));
    return written;
  }
}
