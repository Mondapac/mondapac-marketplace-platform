// Answers of GET certification/admin/issuer-requests and its page (apps/api certification
// issuer-request.dto.ts). The seller's typed text is plain text, never a registry value.

export const REQUESTS_VIEW_PERMISSION = 'certification.issuer.view';
export const REQUESTS_ANSWER_PERMISSION = 'certification.issuer.edit';
export const API_REQUESTS = 'certification/admin/issuer-requests';
export const PAGE_SIZE = 25;

export interface RequestRow {
  readonly issuerRequestId: string;
  readonly version: number;
  readonly typeCode: string;
  readonly sellerId: string;
  /** The seller's public store name; null before the seller is approved. */
  readonly storeName: string | null;
  readonly documentCount: number;
  readonly createdAt: string;
}

export interface RequestPage {
  readonly items: readonly RequestRow[];
  readonly nextAfterId: string | null;
  readonly total: number;
}

export type RequestState = 'open' | 'issuer-added' | 'not-accepted';

export interface RequestDetail {
  readonly issuerRequestId: string;
  readonly version: number;
  readonly state: RequestState;
  readonly typeCode: string;
  readonly sellerId: string;
  readonly storeName: string | null;
  /** The seller's text, decrypted for this read; null when it is no longer available. */
  readonly typedIssuerName: string | null;
  readonly documents: readonly {
    readonly position?: number;
    readonly mediaType?: string;
    readonly byteSize?: number;
    readonly pageCount?: number | null;
  }[];
  readonly createdAt: string;
  readonly answer: {
    readonly issuerId: string | null;
    readonly reasonCode: string | null;
    readonly answeredAt: string;
  } | null;
  readonly activeIssuers: readonly { readonly issuerId: string; readonly displayName: string }[];
  readonly reasons: readonly { readonly code: string; readonly label: string }[];
}
