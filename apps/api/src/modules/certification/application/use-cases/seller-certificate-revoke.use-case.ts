import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_REVOKE } from '../../contracts/permissions';
import { SellerCertificationRevokedAudit } from '../../domain/audit';
import { SellerCertificationRevoked } from '../../domain/events';
import { MAX_REASON_TEXT_LENGTH } from '../../domain/review';
import { revocationReason, revocationRefusal } from '../../domain/revocation';
import { parseCertificateId } from '../own/own-certificate.shared';
import type { RevocationView } from '../ports/review.repository';
import {
  invalid,
  plainTextIn,
  policyOf,
  reviewerOf,
  reviewFailure,
  type ReviewDependencies,
  type ValidationFailure,
} from '../review/review.shared';

export interface RevokeInput {
  readonly certificateId: unknown;
  /** The record's version the admin saw. */
  readonly version: unknown;
  /** Required (AC 16): a code of the Market's list listed for `revoked`. */
  readonly reasonCode: unknown;
  /** Optional note, sealed under the seller's key on the history row. */
  readonly reasonText?: unknown;
}

export interface RevokeOutput {
  readonly certificateId: string;
  readonly status: 'revoked';
  /** The approved submission the record held. */
  readonly submissionId: string;
  /** The pending submission withdrawn in the same unit (cause `revoked`), or null. */
  readonly withdrawnSubmissionId: string | null;
  readonly version: number;
  readonly revokedAt: string;
}

export type RevokeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.revoked' }
  | { readonly code: 'certificate.not-revocable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

function guard(view: RevocationView | null, version: number): RevokeFailure | null {
  if (view === null) return { code: 'certificate.not-found' };
  const refusal = revocationRefusal({
    status: view.certificate.status,
    hasApproval: view.certificate.approvedSubmissionId !== null && view.approved !== null,
  });
  if (refusal !== null) return refusal;
  if (view.certificate.version !== version) return { code: 'conflict.stale' };
  return null;
}

/**
 * `seller-certificate.revoke` (certification design 3.1 last row, 7.2; CERT-16, AC 16): an admin
 * ends an approved or expired certificate with a reason. The request names the record's version.
 * One read-write unit takes the row lock first by moving the version (`lockForDecision`), re-reads
 * the record and re-checks the guards, then withdraws a pending submission (cause `revoked`),
 * writes the history row (reason code, sealed note), sets the record `revoked`, writes the audit
 * row and appends `seller-certification-revoked.v1`. A renewal decision, a seller's edit or submit
 * and the expiry job all move the same version, so whichever commits second gets
 * `conflict.stale`. `evaluateClaims` grants only an `approved` record (design 2.4 rule 1), so the
 * claim is "no" from the commit on. The note is sealed outside the unit; no facade call is made.
 * Rule: key `certification.seller-certificate.revoke` (protected), the admin population, not
 * acting-as. No model is called on this path (ADR-0019 decision 10).
 */
export class RevokeSellerCertificate extends UseCase<RevokeInput, RevokeOutput, RevokeFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-revoke',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_REVOKE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RevokeInput,
  ): Promise<Result<RevokeOutput, RevokeFailure>> {
    const admin = reviewerOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    if (
      typeof input.version !== 'number' ||
      !Number.isInteger(input.version) ||
      input.version < 1 ||
      input.version > 2_147_483_646
    ) {
      return invalid('version', 'format');
    }
    const version = input.version;

    const { deps } = this;
    const { market } = context;
    const policy = policyOf(deps, market);
    if (policy === null) return err({ code: 'access.unavailable' });
    const reason = revocationReason(policy, input.reasonCode);
    if (!reason.ok) return invalid('reasonCode', reason.code);
    const text = plainTextIn(input.reasonText, MAX_REASON_TEXT_LENGTH, { optional: true });
    if (!text.ok) return invalid('reasonText', text.code);

    // 1. The record as the admin saw it: names the seller whose key seals the note.
    const first = await deps.unitOfWork
      .run(market, async () => ok(await deps.reviews.revocationView(market, certificateId)), {
        readOnly: true,
      })
      .catch((error: unknown) => reviewFailure(context, 'certification.revoke.read', error));
    if (!first.ok) return first;
    const refused = guard(first.value, version);
    if (refused !== null) return err(refused);
    const { sellerId } = first.value!.certificate;

    // 2. Outside the unit: the note sealed under the seller's key.
    let noteCiphertext: string | null = null;
    if (text.value !== null) {
      try {
        const sealed = await deps.cipher.seal(market, sellerId, 'history-note', text.value);
        if (!sealed.ok) return err({ code: 'access.denied' });
        noteCiphertext = sealed.value;
      } catch {
        return err({ code: 'access.unavailable' });
      }
    }

    // 3. One unit: lock by version first, re-read, check again, write.
    const now = deps.clock.now();
    const historyId = deps.ids.next<'CertificationHistory'>();
    return deps.unitOfWork
      .run<RevokeOutput, RevokeFailure>(market, async () => {
        await deps.reviews.lockForDecision(market, certificateId, version, now);
        const view = await deps.reviews.revocationView(market, certificateId);
        const again = guard(view, version + 1);
        if (again !== null) return err(again);
        const { certificate, approved } = view!;
        const withdrawn = certificate.pendingSubmissionId;

        await deps.reviews.revoke(market, {
          certificateId,
          approvedSubmissionId: approved!.submissionId,
          withdrawnSubmissionId: withdrawn,
          fromStatus: certificate.status,
          reasonCode: reason.value.code,
          noteCiphertext,
          accountId: admin.accountId,
          revokedAt: now,
          historyId,
        });
        await deps.audit.record(
          context,
          SellerCertificationRevokedAudit.entry(certificateId, {
            after: {
              submissionId: approved!.submissionId,
              typeRevisionId: approved!.typeRevisionId,
              withdrawnSubmissionId: withdrawn,
              noteGiven: noteCiphertext !== null,
            },
          }),
        );
        await deps.outbox.append(context, [
          SellerCertificationRevoked.record({
            aggregateId: certificateId,
            aggregateVersion: version + 1,
            occurredAt: now,
            payload: {
              sellerCertificationId: certificateId,
              sellerId: certificate.sellerId,
              submissionId: approved!.submissionId,
              typeId: certificate.typeId,
            },
          }),
        ]);
        return ok({
          certificateId,
          status: 'revoked' as const,
          submissionId: approved!.submissionId,
          withdrawnSubmissionId: withdrawn,
          version: version + 1,
          revokedAt: now.toString(),
        });
      })
      .catch((error: unknown) => reviewFailure(context, 'certification.revoke.write', error));
  }
}
