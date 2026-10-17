import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_REVIEW } from '../../contracts/permissions';
import { ReviewCheckRecorded } from '../../domain/audit';
import { CHECK_RESULTS, checkCodesFor, type CheckResult } from '../../domain/review';
import { parseCertificateId } from '../own/own-certificate.shared';
import {
  invalid,
  parseSubmissionId,
  policyOf,
  reviewerOf,
  reviewFailure,
  type ReviewDependencies,
  type ValidationFailure,
} from '../review/review.shared';

export interface SellerCertificateRecordCheckInput {
  readonly certificateId: unknown;
  readonly submissionId: unknown;
  readonly checkCode: unknown;
  readonly result: unknown;
}

export interface SellerCertificateRecordCheckOutput {
  readonly checkId: string;
  readonly checkCode: string;
  readonly result: CheckResult;
  readonly recordedAt: string;
}

export type SellerCertificateRecordCheckFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'review.not-current-submission' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `seller-certificate.record-check` (certification design 3.2 rule 3; AC 22): the reviewer records
 * the result (`done`, `problem`, `not-applicable`) of one check of the Market's list for the
 * pending submission. A re-recording adds a new row and the latest row per code counts; every row
 * is audited (`certification.review-check.recorded`, M6). The check must be one the submission's
 * verification mode carries. Recording changes no version: only a decision or a confirmation
 * does. Rule: key `certification.seller-certificate.review`, the admin population, not acting-as.
 */
export class SellerCertificateRecordCheck extends UseCase<
  SellerCertificateRecordCheckInput,
  SellerCertificateRecordCheckOutput,
  SellerCertificateRecordCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-record-check',
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
    input: SellerCertificateRecordCheckInput,
  ): Promise<Result<SellerCertificateRecordCheckOutput, SellerCertificateRecordCheckFailure>> {
    const reviewer = reviewerOf(context, { write: true });
    if (reviewer === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const submissionId = parseSubmissionId(input.submissionId);
    if (submissionId === null) return invalid('submissionId', 'format');
    if (typeof input.checkCode !== 'string') return invalid('checkCode', 'type');
    const checkCode = input.checkCode;
    const result = CHECK_RESULTS.find((value) => value === input.result);
    if (result === undefined) return invalid('result', 'value');

    const { deps } = this;
    const { market } = context;
    const policy = policyOf(deps, market);
    if (policy === null) return err({ code: 'access.unavailable' });
    const now = deps.clock.now();
    const checkId = deps.ids.next<'ReviewCheck'>();
    return deps.unitOfWork
      .run<SellerCertificateRecordCheckOutput, SellerCertificateRecordCheckFailure>(
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
          const known = checkCodesFor(policy, snapshot.submission.verificationMode);
          if (!known.some((check) => check.code === checkCode)) {
            return invalid('checkCode', 'unknown');
          }
          await deps.reviews.recordCheck(market, {
            id: checkId,
            submissionId,
            code: checkCode,
            result,
            accountId: reviewer.accountId,
            now,
          });
          await deps.audit.record(
            context,
            ReviewCheckRecorded.entry(certificateId, {
              after: { submissionId, checkId, result },
            }),
          );
          return ok({ checkId, checkCode, result, recordedAt: now.toString() });
        },
      )
      .catch((error: unknown) => reviewFailure(context, 'certification.record-check', error));
  }
}
