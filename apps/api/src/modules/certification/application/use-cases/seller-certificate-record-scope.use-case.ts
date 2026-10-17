import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_REVIEW } from '../../contracts/permissions';
import { ReviewScopeRecorded } from '../../domain/audit';
import { MAX_SCOPE_LOCATION_LENGTH, MAX_SCOPE_TEXT_LENGTH } from '../../domain/review';
import { parseCertificateId } from '../own/own-certificate.shared';
import {
  invalid,
  parseSubmissionId,
  plainTextIn,
  reviewerOf,
  reviewFailure,
  type ReviewDependencies,
  type ValidationFailure,
} from '../review/review.shared';

export interface SellerCertificateRecordScopeInput {
  readonly certificateId: unknown;
  readonly submissionId: unknown;
  readonly location: unknown;
  readonly scope: unknown;
}

export interface SellerCertificateRecordScopeOutput {
  readonly recordedAt: string;
}

export type SellerCertificateRecordScopeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'review.not-current-submission' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `seller-certificate.record-scope` (certification design 3.2 rule 5): the reviewer writes the
 * location and the scope as read on the certificate, two texts encrypted under the seller's key,
 * for the pending submission. The latest reading counts; an approval of a third-party type needs
 * one. Not enforced on Offers. Audited. Rule: key `certification.seller-certificate.review`, the
 * admin population, not acting-as.
 */
export class SellerCertificateRecordScope extends UseCase<
  SellerCertificateRecordScopeInput,
  SellerCertificateRecordScopeOutput,
  SellerCertificateRecordScopeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-record-scope',
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
    input: SellerCertificateRecordScopeInput,
  ): Promise<Result<SellerCertificateRecordScopeOutput, SellerCertificateRecordScopeFailure>> {
    const reviewer = reviewerOf(context, { write: true });
    if (reviewer === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const submissionId = parseSubmissionId(input.submissionId);
    if (submissionId === null) return invalid('submissionId', 'format');
    const location = plainTextIn(input.location, MAX_SCOPE_LOCATION_LENGTH, { optional: false });
    if (!location.ok) return invalid('location', location.code);
    const scope = plainTextIn(input.scope, MAX_SCOPE_TEXT_LENGTH, { optional: false });
    if (!scope.ok) return invalid('scope', scope.code);

    const { deps } = this;
    const { market } = context;
    // Who the seller is comes from the stored record, never from the request.
    const found = await deps.unitOfWork
      .run(
        market,
        async () => {
          const snapshot = await deps.reviews.snapshot(market, certificateId);
          return ok(snapshot === null ? null : snapshot.certificate.sellerId);
        },
        { readOnly: true },
      )
      .catch((error: unknown) => reviewFailure(context, 'certification.record-scope.read', error));
    if (!found.ok) return found;
    if (found.value === null) return err({ code: 'certificate.not-found' });
    const sellerId = found.value;

    // Seal outside any unit.
    let locationSealed;
    let scopeSealed;
    try {
      locationSealed = await deps.cipher.seal(market, sellerId, 'scope-location', location.value!);
      scopeSealed = await deps.cipher.seal(market, sellerId, 'scope-text', scope.value!);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (!locationSealed.ok || !scopeSealed.ok) return err({ code: 'access.denied' });
    const locationCiphertext = locationSealed.value;
    const scopeCiphertext = scopeSealed.value;

    const now = deps.clock.now();
    const id = deps.ids.next<'ScopeReading'>();
    return deps.unitOfWork
      .run<SellerCertificateRecordScopeOutput, SellerCertificateRecordScopeFailure>(
        market,
        async () => {
          const snapshot = await deps.reviews.snapshot(market, certificateId);
          if (snapshot === null) return err({ code: 'certificate.not-found' } as const);
          if (snapshot.submission === null) {
            return err({ code: 'review.not-current-submission' } as const);
          }
          if (!snapshot.pending || snapshot.submission.id !== submissionId) {
            return err({ code: 'review.not-current-submission' } as const);
          }
          const written = await deps.reviews.recordScope(market, {
            id,
            submissionId,
            locationCiphertext,
            scopeCiphertext,
            accountId: reviewer.accountId,
            now,
          });
          if (!written) return err({ code: 'review.not-current-submission' } as const);
          await deps.audit.record(
            context,
            ReviewScopeRecorded.entry(certificateId, { after: { submissionId } }),
          );
          return ok({ recordedAt: now.toString() });
        },
      )
      .catch((error: unknown) => reviewFailure(context, 'certification.record-scope', error));
  }
}
