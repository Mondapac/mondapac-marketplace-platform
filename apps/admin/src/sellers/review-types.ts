// Answer of GET sellers/admin/:sellerId/review (apps/api review-read.dto.ts). Business details in
// clear: personal data, so the page is rendered per request and never cached.

export const REVIEW_PERMISSION = 'sellers.business-details.view';

export interface ReviewContent {
  readonly storeName: string;
  readonly businessName: string;
  readonly phone: string;
  readonly contactEmail: string | null;
  readonly address: Readonly<Record<string, string>>;
  readonly registeredAddress: Readonly<Record<string, string>> | null;
  readonly identifier: {
    readonly scheme: string;
    readonly value: string;
    readonly display: string;
  } | null;
  readonly registeredForIndirectTax: boolean | null;
}

export interface ReviewRevision {
  readonly id: string;
  readonly kind: string;
  readonly revisionNo: number;
  readonly status: string;
  readonly createdAt: string;
  readonly serviceAreaCode: string;
  readonly operatingTimezone: string;
  readonly registerAtSubmission: {
    readonly outcome: string;
    readonly mismatches: readonly string[];
    readonly checkedAt: string | null;
  };
  readonly content: ReviewContent;
}

export interface ReviewRegister {
  readonly lookup: 'configured' | 'none';
  readonly state: string;
  readonly mismatches: readonly string[];
  readonly staleReason: string | null;
  readonly checkedAt: string | null;
  readonly blocksApproval: boolean;
}

export interface ReviewRead {
  readonly sellerId: string;
  readonly access: string;
  readonly current: ReviewRevision;
  readonly previous: ReviewRevision | null;
  readonly register: ReviewRegister;
}
