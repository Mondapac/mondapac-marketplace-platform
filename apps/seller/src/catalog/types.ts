// Answers of the seller catalog read routes (apps/api own-reads.dto.ts). Instants are ISO 8601
// strings in UTC.

export const VIEW_PERMISSION = 'catalog.own-product.view';
export const EDIT_PERMISSION = 'catalog.own-product.edit';

export interface ProductListItem {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly status: string;
  readonly draftName: string | null;
  readonly hasPublishedRevision: boolean;
  readonly hasPendingRevision: boolean;
  readonly pendingSubmittedAt: string | null;
  readonly lastChangedAt: string;
  readonly createdAt: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextAfterId: string | null;
}

export interface RevisionView {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly submittedAt: string;
  readonly authorKind: string;
  readonly sensitive: boolean;
  readonly sensitiveReasons: readonly string[];
  readonly content: Readonly<Record<string, unknown>>;
}

export interface ProductView {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly familyCode: string;
  readonly status: string;
  readonly variants: readonly { readonly variantId: string; readonly state: string }[];
  readonly maxVariants: number;
  readonly sensitiveFields: readonly string[];
  readonly lastChangedAt: string;
  readonly createdAt: string;
  readonly pendingSubmittedAt: string | null;
  readonly workingCopy: {
    readonly content: Readonly<Record<string, unknown>>;
    readonly lastSavedAt: string;
    readonly baseRevisionId: string | null;
  } | null;
  readonly published: RevisionView | null;
  readonly pending: RevisionView | null;
}

export interface OfferView {
  readonly offerId: string;
  readonly productId: string;
  readonly product: {
    readonly productCode: string | null;
    readonly typeCode: string | null;
    readonly name: string | null;
  };
  readonly sellerSku: string;
  readonly conditionCode: string;
  readonly description: Readonly<Record<string, string>>;
  readonly status: string;
  readonly listed: boolean;
  readonly offSaleCauses: readonly string[];
  readonly handling: string | null;
  readonly attestationRecorded: boolean;
  readonly submittedAt: string | null;
  readonly firstPublishedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

/** `GET catalog/seller/products/options`: what the create form offers. */
export interface ProductOptions {
  readonly productTypes: readonly string[];
  readonly conditions: readonly string[];
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
  readonly sellerCanCreateProduct: boolean;
}

/** `POST catalog/seller/products`: the new draft product and its draft Offer. */
export interface ProductCreated {
  readonly productId: string;
  readonly productCode: string;
  readonly variantIds: readonly string[];
  readonly offerId: string;
}
