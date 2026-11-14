// Answers of GET certification/admin/seller-certificates/:id and the bodies of its writes
// (apps/api certification own-certificate.dto.ts, seller-certificate-review-read.use-case.ts).

export const REVIEW_PERMISSION = 'certification.seller-certificate.review';
export const APPROVE_PERMISSION = 'certification.seller-certificate.approve';
export const API_CERTIFICATES = 'certification/admin/seller-certificates';
export const REASON_TEXT_MAX = 1000;

export type CheckResultCode = 'done' | 'problem' | 'not-applicable';

export interface ReviewCheck {
  readonly code: string;
  readonly required: boolean;
  readonly result: CheckResultCode | null;
  readonly recordedAt: string | null;
}

export interface ReviewReason {
  readonly code: string;
  readonly check: string | null;
  readonly nextStep: string;
}

export interface ReviewDocument {
  readonly position?: number;
  readonly mediaType?: string;
  readonly byteSize?: number;
  readonly pageCount?: number | null;
}

export interface ReviewPage {
  readonly certificate: {
    readonly certificateId: string;
    readonly sellerId: string;
    readonly typeCode: string;
    readonly status: string;
    /** The version a decision must name. */
    readonly version: number;
    readonly createdAt: string;
  };
  readonly submission: {
    readonly submissionId: string;
    readonly submissionNo: number;
    readonly kind: string;
    readonly pending: boolean;
    readonly verificationMode: string;
    readonly requiresDocument: boolean;
    readonly requiresExpiry: boolean;
    readonly issuer: {
      readonly issuerId: string;
      readonly displayName: string;
      readonly state: string;
    } | null;
    readonly certificateNumber: string | null;
    readonly issueDate: string | null;
    readonly expiryDate: string | null;
    readonly selfDeclared: boolean | null;
    readonly selfDeclarationNote: string | null;
    readonly submittedZone: string;
    readonly submittedAt: string;
  };
  readonly documents: readonly ReviewDocument[];
  readonly checks: readonly ReviewCheck[];
  readonly scope: {
    readonly location: string | null;
    readonly scope: string | null;
    readonly recordedAt: string;
  } | null;
  readonly confirmation: {
    readonly confirmedOn: string;
    readonly recordedAt: string;
  } | null;
  readonly reasons: {
    readonly 'changes-requested'?: readonly ReviewReason[];
    readonly declined?: readonly ReviewReason[];
  };
  readonly duplicateHints: readonly {
    readonly kind: 'number' | 'file';
    readonly certificateId: string;
    readonly storeName: string | null;
  }[];
  readonly business: {
    readonly status: 'ok' | 'not-found' | 'denied' | 'unavailable';
    readonly businessName?: string;
    readonly storeName?: string;
  };
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
    readonly decidedAt: string;
  } | null;
}
