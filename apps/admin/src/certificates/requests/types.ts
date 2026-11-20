// Answers of GET certification/admin/issuer-requests and its page (apps/api certification
// issuer-request.dto.ts). The seller's typed text is plain text, never a registry value.

export const REQUESTS_VIEW_PERMISSION = 'certification.issuer.view';
export const REQUESTS_ANSWER_PERMISSION = 'certification.issuer.edit';
export const API_REQUESTS = 'certification/admin/issuer-requests';
export const API_REQUESTS_LIST = `${API_REQUESTS}/list`;
export const API_REQUESTS_EXPORT = `${API_REQUESTS}/export`;

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

/** The answer of the plain request read (the Certificates tabs ask it for the open count). */
export interface RequestPage {
  readonly items: readonly RequestRow[];
  readonly nextAfterId: string | null;
  readonly total: number;
}

/** A row of the super list (GET certification/admin/issuer-requests/list), with its actions. */
export interface ListRow extends RequestRow {
  /** What this admin may do with the row: `open` always, `answer` with the edit key (server-computed). */
  readonly actions: readonly string[];
}

/** The answer of the super list. `total` is null with the Market's Previous and next paging. */
export interface ListPage {
  readonly items: readonly ListRow[];
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: 'pages' | 'prev-next';
  readonly hasNext: boolean;
  readonly counts: { readonly all: number };
  /** More requests are open than the 500 the list reads: the newest are not listed. */
  readonly truncated: boolean;
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
    readonly documentId?: string;
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
