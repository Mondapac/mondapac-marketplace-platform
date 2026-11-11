// Answers of GET certification/admin/seller-certificates and certification/admin/types
// (apps/api certification own-certificate.dto.ts, registry.dto.ts). Ids, instants and codes only.

export const VIEW_PERMISSION = 'certification.seller-certificate.view';
export const TYPE_VIEW_PERMISSION = 'certification.type.view';
export const PAGE_SIZE = 25;

export type SubmissionKind = 'initial' | 'resubmission' | 'renewal';

export interface QueueRow {
  readonly certificateId: string;
  /** The record version a decision must name. */
  readonly version: number;
  readonly submissionId: string;
  readonly submissionNo: number;
  readonly kind: SubmissionKind;
  readonly typeCode: string;
  readonly sellerId: string;
  /** The seller's public store name; null before the seller is approved. */
  readonly storeName: string | null;
  readonly issuerName: string | null;
  readonly submittedAt: string;
}

export interface QueuePage {
  readonly items: readonly QueueRow[];
  readonly nextAfterId: string | null;
  readonly total: number;
}

export interface TypeListRow {
  readonly code: string;
  /** Display names by locale. */
  readonly names: Readonly<Record<string, string>>;
}

export interface TypesList {
  readonly items: readonly TypeListRow[];
}
