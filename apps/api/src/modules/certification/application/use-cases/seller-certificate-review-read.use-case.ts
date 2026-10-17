import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_REVIEW } from '../../contracts/permissions';
import { ReviewPageViewed } from '../../domain/audit';
import {
  checkCodesFor,
  submissionStatusOf,
  type CheckResult,
  type NegativeOutcome,
  type ReviewPolicy,
  type SubmissionStatus,
} from '../../domain/review';
import type { CertificateField } from '../ports/document-ports';
import type { BusinessDetailsAnswer } from '../ports/review.ports';
import type { DuplicateHint, ReviewSnapshot } from '../ports/review.repository';
import {
  invalid,
  policyOf,
  reviewerOf,
  reviewFailure,
  type ReviewDependencies,
  type ValidationFailure,
} from '../review/review.shared';
import {
  parseCertificateId,
  documentViewOf,
  type DocumentView,
} from '../own/own-certificate.shared';

export interface SellerCertificateReviewReadInput {
  readonly certificateId: unknown;
  /** How the reviewer got here: `duplicate-hint` when they followed a hint's link. */
  readonly reason?: unknown;
}

export interface ReviewCheckView {
  readonly code: string;
  readonly required: boolean;
  readonly result: CheckResult | null;
  readonly recordedAt: string | null;
}

export interface ReviewReasonView {
  readonly code: string;
  readonly check: string | null;
  readonly nextStep: string;
}

/**
 * Another submission of the record (AC 15): what was sent, how it was decided and why. Personal
 * data (number, reason text) is decrypted for the reviewer; the route is `no-store`.
 */
export interface OtherSubmissionView {
  readonly submissionId: string;
  readonly submissionNo: number;
  readonly kind: string;
  /** Derived (design 3.2): `approved` is the certificate in force, `superseded` an older one. */
  readonly status: SubmissionStatus;
  readonly submittedAt: string;
  readonly issuerName: string | null;
  readonly certificateNumber: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  /** For an approval: the boundary stored with it (00:00 after the expiry date, seller zone). */
  readonly validUntil: string | null;
  readonly decision: {
    readonly outcome: string;
    readonly reasonCode: string | null;
    readonly reasonText: string | null;
    readonly withdrawCause: string | null;
    readonly decidedAt: string;
  } | null;
}

export interface SellerCertificateReviewReadOutput {
  readonly certificate: {
    readonly certificateId: string;
    readonly sellerId: string;
    readonly typeCode: string;
    /** The record's own status. */
    readonly status: string;
    /** The version a decision must name. */
    readonly version: number;
    readonly createdAt: string;
  };
  readonly submission: {
    readonly submissionId: string;
    readonly submissionNo: number;
    readonly kind: string;
    /** True while the submission can be decided; false for an approved one (late confirmation). */
    readonly pending: boolean;
    readonly typeRevisionId: string;
    readonly verificationMode: string;
    readonly requiresDocument: boolean;
    readonly requiresExpiry: boolean;
    readonly issuer: {
      readonly issuerId: string;
      readonly displayName: string;
      readonly state: string;
      readonly channels: readonly {
        readonly channelId: string;
        readonly kind: string;
        readonly value: string;
      }[];
    } | null;
    /** Personal data: decrypted for the reviewer; `no-store` on the route. */
    readonly certificateNumber: string | null;
    readonly issueDate: string | null;
    readonly expiryDate: string | null;
    readonly selfDeclared: boolean | null;
    readonly selfDeclarationNote: string | null;
    readonly submittedZone: string;
    readonly submittedAt: string;
  };
  readonly documents: readonly DocumentView[];
  readonly checks: readonly ReviewCheckView[];
  readonly scope: {
    readonly location: string | null;
    readonly scope: string | null;
    readonly recordedAt: string;
  } | null;
  readonly confirmation: {
    readonly issuerId: string;
    readonly channelId: string;
    readonly confirmedOn: string;
    readonly reference: string | null;
    readonly recordedAt: string;
  } | null;
  /** The reasons a reviewer may give, by outcome. */
  readonly reasons: Readonly<Record<NegativeOutcome, readonly ReviewReasonView[]>>;
  /** Other sellers' certificates with the same number or file; a hint, never a refusal. */
  readonly duplicateHints: readonly {
    readonly kind: 'number' | 'file';
    readonly certificateId: string;
    readonly storeName: string | null;
  }[];
  /** The seller's business details; `status` says why they are absent. */
  readonly business: {
    readonly status: 'ok' | 'not-found' | 'denied' | 'unavailable';
    readonly businessName?: string;
    readonly storeName?: string;
    readonly operatingAddress?: Readonly<Record<string, string>>;
    readonly registeredAddress?: Readonly<Record<string, string>> | null;
  };
  /** The minimal history (CERT-17): status moves, newest last. */
  readonly history: readonly {
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly occurredAt: string;
    readonly actorKind: string;
    readonly reasonCode: string | null;
  }[];
  readonly decision: {
    readonly outcome: string;
    readonly reasonCode: string | null;
    readonly reasonText: string | null;
    readonly decidedAt: string;
  } | null;
  /**
   * The record's other submissions, newest first (at most 10, plus the approved one): the earlier
   * submission and its reason for a correction, the certificate in force beside a renewal.
   */
  readonly otherSubmissions: readonly OtherSubmissionView[];
}

export type SellerCertificateReviewReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `seller-certificate.review-read` (certification design 7.2; AC 22): the review page of one
 * certificate. It shows the submission a reviewer decides on (the pending one, else the approved
 * one), decrypts the number, the note, the scope, the confirmation reference and the reason under
 * the seller's key, lists the files, the Market's checks with their latest result, the reasons,
 * the duplicate hints (other sellers' store names only) and the minimal history, and calls
 * `sellers.reviewerBusinessDetails` for the business names and addresses. One
 * `certification.review-page.viewed` audit row is written per read in its own unit and a refused
 * row returns nothing. The route sends `Cache-Control: no-store`. Rule: key
 * `certification.seller-certificate.review` and the admin population.
 */
export class SellerCertificateReviewRead extends UseCase<
  SellerCertificateReviewReadInput,
  SellerCertificateReviewReadOutput,
  SellerCertificateReviewReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-review-read',
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
    input: SellerCertificateReviewReadInput,
  ): Promise<Result<SellerCertificateReviewReadOutput, SellerCertificateReviewReadFailure>> {
    if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    let reason: 'review' | 'duplicate-hint' = 'review';
    if (input.reason !== undefined && input.reason !== null) {
      if (input.reason !== 'duplicate-hint' && input.reason !== 'review') {
        return invalid('reason', 'value');
      }
      reason = input.reason;
    }

    const { deps } = this;
    const { market } = context;
    const policy = policyOf(deps, market);
    if (policy === null) return err({ code: 'access.unavailable' });

    const read = await deps.unitOfWork
      .run(
        market,
        async () => {
          const snapshot = await deps.reviews.snapshot(market, certificateId, { others: true });
          if (snapshot === null || snapshot.submission === null) return ok(null);
          const hints = await deps.reviews.duplicateHints(
            market,
            snapshot.submission.id,
            snapshot.certificate.sellerId,
          );
          return ok({ snapshot, hints });
        },
        { readOnly: true },
      )
      .catch((error: unknown) => reviewFailure(context, 'certification.review-read', error));
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'certificate.not-found' });
    const { snapshot, hints } = read.value;
    const submission = snapshot.submission!;
    const { sellerId } = snapshot.certificate;

    // Decrypt outside any unit (design 4.3: one key unwrap for the seller's fields).
    const open = async (field: CertificateField, sealed: string | null): Promise<string | null> => {
      if (sealed === null) return null;
      try {
        const opened = await deps.cipher.open(market, sellerId, field, sealed);
        return opened.ok ? opened.value : null;
      } catch {
        return null;
      }
    };
    const [certificateNumber, note, location, scopeText, reference, reasonText] = await Promise.all(
      [
        open('submission-certificate-number', submission.certificateNumberCiphertext),
        open('submission-self-declaration-note', submission.selfDeclarationNoteCiphertext),
        open('scope-location', submission.scope?.locationCiphertext ?? null),
        open('scope-text', submission.scope?.scopeCiphertext ?? null),
        open('confirmation-reference', submission.confirmation?.referenceCiphertext ?? null),
        open('decision-reason-text', submission.decision?.reasonTextCiphertext ?? null),
      ],
    );
    const others = await Promise.all(
      snapshot.others.map(async (other) => ({
        certificateNumber: await open(
          'submission-certificate-number',
          other.certificateNumberCiphertext,
        ),
        reasonText: await open(
          'decision-reason-text',
          other.decision?.reasonTextCiphertext ?? null,
        ),
      })),
    );

    let business: BusinessDetailsAnswer;
    try {
      business = await deps.sellers.businessDetails(context, sellerId);
    } catch {
      business = { status: 'unavailable' };
    }
    const names = await deps.sellers.storeNames(context, [
      ...new Set(hints.map((hint) => hint.sellerId)),
    ] as Id<'Seller'>[]);

    // The audit row, in its own unit; a refused row means nothing is returned (design 11).
    const audited = await deps.unitOfWork
      .run(market, async () => {
        await deps.audit.record(
          context,
          ReviewPageViewed.entry(certificateId, {
            after: { submissionId: submission.id, reason },
          }),
        );
        return ok(undefined);
      })
      .catch((error: unknown) => reviewFailure(context, 'certification.review-read.audit', error));
    if (!audited.ok) return err({ code: 'access.unavailable' });

    return ok(
      outputOf(snapshot, policy, hints, names, business, {
        certificateNumber,
        note,
        location,
        scopeText,
        reference,
        reasonText,
        others,
      }),
    );
  }
}

interface Clear {
  readonly certificateNumber: string | null;
  readonly note: string | null;
  readonly location: string | null;
  readonly scopeText: string | null;
  readonly reference: string | null;
  readonly reasonText: string | null;
  /** Per entry of `snapshot.others`, in order. */
  readonly others: readonly {
    readonly certificateNumber: string | null;
    readonly reasonText: string | null;
  }[];
}

function outputOf(
  snapshot: ReviewSnapshot,
  policy: ReviewPolicy,
  hints: readonly DuplicateHint[],
  names: ReadonlyMap<Id<'Seller'>, string>,
  business: BusinessDetailsAnswer,
  clear: Clear,
): SellerCertificateReviewReadOutput {
  const { certificate } = snapshot;
  const submission = snapshot.submission!;
  const latest = new Map(submission.checks.map((check) => [check.code, check]));
  const reasonsOf = (outcome: NegativeOutcome): readonly ReviewReasonView[] =>
    policy.reasons
      .filter((reason) => reason.outcomes.includes(outcome))
      .map(({ code, check, nextStep }) => ({ code, check, nextStep }));
  return {
    certificate: {
      certificateId: certificate.id,
      sellerId: certificate.sellerId,
      typeCode: certificate.typeCode,
      status: certificate.status,
      version: certificate.version,
      createdAt: certificate.createdAt.toString(),
    },
    submission: {
      submissionId: submission.id,
      submissionNo: submission.submissionNo,
      kind: submission.kind,
      pending: snapshot.pending,
      typeRevisionId: submission.typeRevisionId,
      verificationMode: submission.verificationMode,
      requiresDocument: submission.requiresDocument,
      requiresExpiry: submission.requiresExpiry,
      issuer:
        submission.issuer === null
          ? null
          : {
              issuerId: submission.issuer.id,
              displayName: submission.issuer.displayName,
              state: submission.issuer.state,
              channels: submission.issuer.channels
                .filter((channel) => !channel.retired)
                .map((channel) => ({
                  channelId: channel.id,
                  kind: channel.kind,
                  value: channel.value,
                })),
            },
      certificateNumber: clear.certificateNumber,
      issueDate: submission.issueDate === null ? null : submission.issueDate.toString(),
      expiryDate: submission.expiryDate === null ? null : submission.expiryDate.toString(),
      selfDeclared: submission.selfDeclared,
      selfDeclarationNote: clear.note,
      submittedZone: submission.submittedZone,
      submittedAt: submission.submittedAt.toString(),
    },
    documents: submission.documents.map(documentViewOf),
    checks: checkCodesFor(policy, submission.verificationMode).map((check) => {
      const row = latest.get(check.code);
      return {
        code: check.code,
        required: check.required,
        result: row?.result ?? null,
        recordedAt: row === undefined ? null : row.recordedAt.toString(),
      };
    }),
    scope:
      submission.scope === null
        ? null
        : {
            location: clear.location,
            scope: clear.scopeText,
            recordedAt: submission.scope.recordedAt.toString(),
          },
    confirmation:
      submission.confirmation === null
        ? null
        : {
            issuerId: submission.confirmation.issuerId,
            channelId: submission.confirmation.channelId,
            confirmedOn: submission.confirmation.confirmedOn.toString(),
            reference: clear.reference,
            recordedAt: submission.confirmation.recordedAt.toString(),
          },
    reasons: {
      'changes-requested': reasonsOf('changes-requested'),
      declined: reasonsOf('declined'),
    },
    duplicateHints: hints.map((hint) => ({
      kind: hint.kind,
      certificateId: hint.certificateId,
      storeName: names.get(hint.sellerId) ?? null,
    })),
    business:
      business.status === 'ok'
        ? {
            status: 'ok',
            businessName: business.details.businessName,
            storeName: business.details.storeName,
            operatingAddress: business.details.operatingAddress,
            registeredAddress: business.details.registeredAddress,
          }
        : { status: business.status },
    history: snapshot.history.map((row) => ({
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      occurredAt: row.occurredAt.toString(),
      actorKind: row.actorKind,
      reasonCode: row.reasonCode,
    })),
    decision:
      submission.decision === null
        ? null
        : {
            outcome: submission.decision.outcome,
            reasonCode: submission.decision.reasonCode,
            reasonText: clear.reasonText,
            decidedAt: submission.decision.decidedAt.toString(),
          },
    otherSubmissions: snapshot.others.map((other, index) => ({
      submissionId: other.id,
      submissionNo: other.submissionNo,
      kind: other.kind,
      status: submissionStatusOf({
        outcome: other.decision?.outcome ?? null,
        pending: certificate.pendingSubmissionId === other.id,
        current: certificate.approvedSubmissionId === other.id,
      }),
      submittedAt: other.submittedAt.toString(),
      issuerName: other.issuerName,
      certificateNumber: clear.others[index]?.certificateNumber ?? null,
      issueDate: other.issueDate === null ? null : other.issueDate.toString(),
      expiryDate: other.expiryDate === null ? null : other.expiryDate.toString(),
      validUntil:
        other.decision?.outcome === 'approved' && other.decision.expiryBoundaryAt !== null
          ? other.decision.expiryBoundaryAt.toString()
          : null,
      decision:
        other.decision === null
          ? null
          : {
              outcome: other.decision.outcome,
              reasonCode: other.decision.reasonCode,
              reasonText: clear.others[index]?.reasonText ?? null,
              withdrawCause: other.decision.withdrawCause,
              decidedAt: other.decision.decidedAt.toString(),
            },
    })),
  };
}
