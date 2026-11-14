import type { ReviewPage } from './types.ts';

/**
 * The fields the review screen shows, copied out of the API answer. The answer also carries
 * decrypted data this screen does not use (other submissions' numbers and reason texts, the
 * confirmation reference, issuer contact values, addresses); none of it travels on to the
 * components.
 */
export function pickReviewPage(body: ReviewPage): ReviewPage {
  const { certificate, submission, scope, confirmation, business, decision } = body;
  return {
    certificate: {
      certificateId: certificate.certificateId,
      sellerId: certificate.sellerId,
      typeCode: certificate.typeCode,
      status: certificate.status,
      version: certificate.version,
      createdAt: certificate.createdAt,
    },
    submission: {
      submissionId: submission.submissionId,
      submissionNo: submission.submissionNo,
      kind: submission.kind,
      pending: submission.pending,
      verificationMode: submission.verificationMode,
      requiresDocument: submission.requiresDocument,
      requiresExpiry: submission.requiresExpiry,
      issuer:
        submission.issuer === null
          ? null
          : {
              issuerId: submission.issuer.issuerId,
              displayName: submission.issuer.displayName,
              state: submission.issuer.state,
            },
      certificateNumber: submission.certificateNumber,
      issueDate: submission.issueDate,
      expiryDate: submission.expiryDate,
      selfDeclared: submission.selfDeclared,
      selfDeclarationNote: submission.selfDeclarationNote,
      submittedZone: submission.submittedZone,
      submittedAt: submission.submittedAt,
    },
    documents: body.documents.map((doc) => ({
      position: doc.position,
      mediaType: doc.mediaType,
      byteSize: doc.byteSize,
      pageCount: doc.pageCount,
    })),
    checks: body.checks.map((check) => ({
      code: check.code,
      required: check.required,
      result: check.result,
      recordedAt: check.recordedAt,
    })),
    scope:
      scope === null
        ? null
        : { location: scope.location, scope: scope.scope, recordedAt: scope.recordedAt },
    confirmation:
      confirmation === null
        ? null
        : { confirmedOn: confirmation.confirmedOn, recordedAt: confirmation.recordedAt },
    reasons: {
      'changes-requested': (body.reasons['changes-requested'] ?? []).map((r) => ({
        code: r.code,
        check: r.check,
        nextStep: r.nextStep,
      })),
      declined: (body.reasons.declined ?? []).map((r) => ({
        code: r.code,
        check: r.check,
        nextStep: r.nextStep,
      })),
    },
    duplicateHints: body.duplicateHints.map((hint) => ({
      kind: hint.kind,
      certificateId: hint.certificateId,
      storeName: hint.storeName,
    })),
    business: {
      status: business.status,
      ...(business.businessName === undefined ? {} : { businessName: business.businessName }),
      ...(business.storeName === undefined ? {} : { storeName: business.storeName }),
    },
    history: body.history.map((entry) => ({
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      occurredAt: entry.occurredAt,
      actorKind: entry.actorKind,
      reasonCode: entry.reasonCode,
    })),
    decision:
      decision === null
        ? null
        : {
            outcome: decision.outcome,
            reasonCode: decision.reasonCode,
            decidedAt: decision.decidedAt,
          },
  };
}
