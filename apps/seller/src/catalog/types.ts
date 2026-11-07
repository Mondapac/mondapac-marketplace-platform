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

export interface FormOption {
  readonly code: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** One field of the product family (apps/api OwnFormField). */
export interface FormField {
  readonly code: string;
  readonly dataType: string;
  readonly localizable: boolean;
  readonly required: boolean;
  readonly isVariantOption: boolean;
  /** For a `measure` field, `min` and `max` are in base units (g, ml, mm, count). */
  readonly bounds: { readonly maxLength?: number; readonly min?: number; readonly max?: number };
  /** A `measure` field only: dimension, the unit codes offered, the default and decimal places. */
  readonly measure?: {
    readonly dimension: string;
    readonly units: readonly string[];
    readonly defaultUnit: string;
    readonly decimals: number;
  };
  readonly names: Readonly<Record<string, string>>;
  readonly options: readonly FormOption[];
}

/** A unit of the Market with its label per locale (apps/api OwnFormUnit). */
export interface FormUnit {
  readonly code: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface FormCategory {
  readonly categoryId: string;
  readonly parentId: string | null;
  readonly names: Readonly<Record<string, string>>;
}

/** What the product form is drawn from: `GET catalog/seller/products/:id` -> `form`. */
export interface ProductForm {
  readonly taxCategoryCodes: readonly string[];
  /** The Market's units; a measure field names the ones it offers by code. */
  readonly units: readonly FormUnit[];
  readonly fields: readonly FormField[];
  readonly categories: readonly FormCategory[];
}

/** A value the seller asked for on a select field (`GET catalog/seller/products/:id` -> `suggestions`). */
export interface ValueSuggestion {
  readonly id: string;
  readonly attributeCode: string;
  /** The seller's own text: shown as plain text only. */
  readonly label: string;
  readonly status: 'open' | 'approved' | 'mapped' | 'rejected';
  readonly optionCode: string | null;
  /** The reviewer's words, when the suggestion was rejected. */
  readonly rejectReason: string | null;
  readonly createdAt: string;
}

export interface ProductView {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly familyCode: string;
  /** `single`: one fixed variant; `configurable`: variants defined by option values. */
  readonly variantModel: string;
  readonly status: string;
  readonly variants: readonly { readonly variantId: string; readonly state: string }[];
  readonly maxVariants: number;
  readonly sensitiveFields: readonly string[];
  readonly lastChangedAt: string;
  readonly createdAt: string;
  readonly pendingSubmittedAt: string | null;
  readonly form: ProductForm;
  readonly workingCopy: {
    readonly content: Readonly<Record<string, unknown>>;
    readonly lastSavedAt: string;
    readonly baseRevisionId: string | null;
  } | null;
  readonly published: RevisionView | null;
  readonly pending: RevisionView | null;
  /** Newest first. An open one keeps its field empty. */
  readonly suggestions?: readonly ValueSuggestion[];
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

/** One sell unit (variant) of an offer: `GET catalog/seller/offers/:id/sell-units` -> `units`. */
export interface SellUnitView {
  readonly variantId: string;
  readonly variantNo: number;
  readonly variantCode: string;
  readonly state: 'proposed' | 'published';
  /** The published variant label in the Market's default locale, else null. */
  readonly label: string | null;
  readonly selling: boolean;
  readonly variantSku: string | null;
  /** What exports and invoices show: the variant SKU, else `{sellerSku}-{variantNo}`. */
  readonly displaySku: string;
}

/** `GET catalog/seller/offers/:id/sell-units`. */
export interface OfferSellUnitsView {
  readonly productScope: 'PLATFORM' | 'SELLER';
  readonly sellerSku: string;
  readonly units: readonly SellUnitView[];
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

/** `PUT catalog/seller/products/:id/draft`: the variant ids the server holds and the texts it kept. */
export interface DraftSaved {
  readonly variantIds: readonly string[];
  readonly refusedFields: readonly {
    readonly field: string;
    readonly ref: string | null;
    readonly locale: string;
    readonly code: string;
  }[];
  /** Advice about the saved variants; never a refusal. */
  readonly variantNotices?: readonly {
    readonly variantId: string;
    readonly code: 'gtin.duplicate';
    /** The PLATFORM product that already carries the barcode, when there is one to sell on. */
    readonly sellOnProductCode: string | null;
  }[];
}

/** `POST catalog/seller/products/:id/submit`. */
export interface Submitted {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly published: boolean;
}

/** One photo of the product library (`GET catalog/seller/products/:id/images`). */
export interface ProductPhoto {
  readonly imageId: string;
  readonly width: number;
  readonly height: number;
  readonly createdAt: string;
}

export interface PhotoList {
  readonly images: readonly ProductPhoto[];
}

/** One of the seller's value suggestions (`GET catalog/seller/attribute-suggestions` -> `items`). */
export interface OwnSuggestion {
  readonly id: string;
  readonly status: 'open' | 'approved' | 'mapped' | 'rejected';
  /** The seller's own text: shown as plain text only. */
  readonly label: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  /** The reviewer's words, when the suggestion was rejected. Plain text. */
  readonly rejectReason: string | null;
  /** Null when the field can no longer be read. */
  readonly attribute: {
    readonly code: string;
    readonly names: Readonly<Record<string, string>>;
  } | null;
  /** The value added (approved) or matched (mapped). */
  readonly value: {
    readonly code: string;
    readonly labels: Readonly<Record<string, string>>;
  } | null;
  readonly product: {
    readonly id: string;
    /** Null when the product can no longer be read. */
    readonly productCode: string | null;
    readonly name: string | null;
  };
}

export interface OwnSuggestionList {
  readonly items: readonly OwnSuggestion[];
  readonly nextAfterId: string | null;
  /** How many wait for a decision, whatever the filter. */
  readonly openCount: number;
  readonly maxOpen: number;
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
}

export const SUGGESTION_STATUSES = ['open', 'approved', 'mapped', 'rejected'] as const;
