import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_REVIEW } from '../../contracts/permissions';
import { IssuerConfirmationRecorded } from '../../domain/audit';
import { SellerCertificationIssuerConfirmed } from '../../domain/events';
import { MAX_CONFIRMATION_REFERENCE_LENGTH } from '../../domain/review';
import { parseCertificateId } from '../own/own-certificate.shared';
import {
  invalid,
  parseChannelId,
  parseSubmissionId,
  plainTextIn,
  reviewerOf,
  reviewFailure,
  type ReviewDependencies,
  type ValidationFailure,
} from '../review/review.shared';

export interface SellerCertificateRecordConfirmationInput {
  readonly certificateId: unknown;
  readonly submissionId: unknown;
  readonly channelId: unknown;
  /** The date of the confirmation, `YYYY-MM-DD`. */
  readonly confirmedOn: unknown;
  readonly reference: unknown;
  readonly confirmsNumber: unknown;
  readonly confirmsHolder: unknown;
}

export interface SellerCertificateRecordConfirmationOutput {
  readonly submissionId: string;
  /** The version after the change, for the next decision. */
  readonly version: number;
  readonly recordedAt: string;
}

export type SellerCertificateRecordConfirmationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'review.not-current-submission' }
  | { readonly code: 'confirmation.exists' }
  | { readonly code: 'confirmation.no-issuer' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `seller-certificate.record-issuer-confirmation` (certification design 3.2 rule 7; AC 23): the
 * reviewer records that they confirmed the certificate with its issuer, on the pending submission
 * or on the approved one. The channel is chosen from the issuer's **registered** channels (never
 * typed in), the date and an encrypted reference are kept, and both ticks (the number, the
 * holder) are required: the submission is then `verifiedWithIssuer`. One confirmation per
 * submission. It never changes "allowed". It moves the record's version and publishes
 * `seller-certification-issuer-confirmed.v1`. Audited. Rule: key
 * `certification.seller-certificate.review`, the admin population, not acting-as.
 */
export class SellerCertificateRecordConfirmation extends UseCase<
  SellerCertificateRecordConfirmationInput,
  SellerCertificateRecordConfirmationOutput,
  SellerCertificateRecordConfirmationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-record-confirmation',
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
    input: SellerCertificateRecordConfirmationInput,
  ): Promise<
    Result<SellerCertificateRecordConfirmationOutput, SellerCertificateRecordConfirmationFailure>
  > {
    const reviewer = reviewerOf(context, { write: true });
    if (reviewer === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const submissionId = parseSubmissionId(input.submissionId);
    if (submissionId === null) return invalid('submissionId', 'format');
    const channelId = parseChannelId(input.channelId);
    if (channelId === null) return invalid('channelId', 'format');
    const reference = plainTextIn(input.reference, MAX_CONFIRMATION_REFERENCE_LENGTH, {
      optional: false,
    });
    if (!reference.ok) return invalid('reference', reference.code);
    if (input.confirmsNumber !== true) return invalid('confirmsNumber', 'must-be-true');
    if (input.confirmsHolder !== true) return invalid('confirmsHolder', 'must-be-true');
    if (typeof input.confirmedOn !== 'string' || !DATE.test(input.confirmedOn)) {
      return invalid('confirmedOn', 'format');
    }
    let confirmedOn: Temporal.PlainDate;
    try {
      confirmedOn = Temporal.PlainDate.from(input.confirmedOn, { overflow: 'reject' });
    } catch {
      return invalid('confirmedOn', 'format');
    }

    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    // The reviewer's date may be a day ahead of UTC; anything later is a typing error.
    const latest = now.toZonedDateTimeISO('UTC').toPlainDate().add({ days: 1 });
    if (Temporal.PlainDate.compare(confirmedOn, latest) > 0) {
      return invalid('confirmedOn', 'in-the-future');
    }

    const found = await deps.unitOfWork
      .run(
        market,
        async () => {
          const snapshot = await deps.reviews.snapshot(market, certificateId);
          return ok(snapshot === null ? null : snapshot.certificate.sellerId);
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        reviewFailure(context, 'certification.record-confirmation.read', error),
      );
    if (!found.ok) return found;
    if (found.value === null) return err({ code: 'certificate.not-found' });
    const sellerId = found.value;

    let sealed;
    try {
      sealed = await deps.cipher.seal(market, sellerId, 'confirmation-reference', reference.value!);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (!sealed.ok) return err({ code: 'access.denied' });
    const referenceCiphertext = sealed.value;

    return deps.unitOfWork
      .run<SellerCertificateRecordConfirmationOutput, SellerCertificateRecordConfirmationFailure>(
        market,
        async () => {
          const snapshot = await deps.reviews.snapshot(market, certificateId);
          if (snapshot === null) return err({ code: 'certificate.not-found' } as const);
          if (snapshot.submission === null) {
            return err({ code: 'review.not-current-submission' } as const);
          }
          const { submission, certificate } = snapshot;
          if (submission.id !== submissionId) {
            return err({ code: 'review.not-current-submission' } as const);
          }
          if (submission.issuer === null) return err({ code: 'confirmation.no-issuer' } as const);
          const channel = submission.issuer.channels.find((c) => c.id === channelId);
          if (channel === undefined || channel.retired) return invalid('channelId', 'unknown');
          if (submission.confirmation !== null)
            return err({ code: 'confirmation.exists' } as const);
          const recorded = await deps.reviews.recordConfirmation(market, {
            certificateId,
            expectedVersion: certificate.version,
            submissionId,
            issuerId: submission.issuer.id,
            channelId,
            confirmedOn,
            referenceCiphertext,
            accountId: reviewer.accountId,
            now,
          });
          if (recorded === 'exists') return err({ code: 'confirmation.exists' } as const);
          await deps.audit.record(
            context,
            IssuerConfirmationRecorded.entry(certificateId, {
              after: { submissionId, issuerId: submission.issuer.id },
            }),
          );
          await deps.outbox.append(context, [
            SellerCertificationIssuerConfirmed.record({
              aggregateId: certificateId,
              aggregateVersion: certificate.version + 1,
              occurredAt: now,
              payload: { sellerCertificationId: certificateId, sellerId, submissionId },
            }),
          ]);
          return ok({
            submissionId,
            version: certificate.version + 1,
            recordedAt: now.toString(),
          });
        },
      )
      .catch((error: unknown) =>
        reviewFailure(context, 'certification.record-confirmation', error),
      );
  }
}
