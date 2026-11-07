// Answers of the admin product revision routes (apps/api product-review.dto.ts and
// product-image-review.controller.ts). Ids, codes and the seller's own product content only.

export const REVIEW_CHECKS = [
  'photos-no-certification-mark',
  'category-fits',
  'tax-category-fits',
  'not-a-duplicate',
] as const;

/** Why a reviewer sends a product revision back (apps/api PRODUCT_CHANGE_REASONS). */
export const PRODUCT_CHANGE_REASONS = [
  'content-unclear',
  'description-claim',
  'sku-or-condition',
  'handling-unclear',
  'photos',
  'category',
  'tax-category',
  'duplicate',
  'other',
] as const;

/** Why a reviewer takes a photo down (apps/api IMAGE_TAKEDOWN_REASONS). */
export const TAKEDOWN_REASONS = [
  'certification-mark',
  'misleading',
  'rights',
  'unsafe-or-illegal',
  'other',
] as const;

export interface RevisionText {
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
}

export interface RevisionVariant {
  readonly variantId: string;
  readonly position: number;
  /** Option code to value. */
  readonly optionValues: Readonly<Record<string, string>>;
  /** Locale to label. */
  readonly labels: Readonly<Record<string, string>>;
  readonly gtin: string | null;
  readonly shippingWeightGrams: number | null;
  readonly shippingLengthMm: number | null;
  readonly shippingWidthMm: number | null;
  readonly shippingHeightMm: number | null;
  readonly imageIds: readonly string[];
}

export interface RevisionContent {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly kind: string;
  readonly authorKind: string;
  readonly submittedAt: string;
  /** Locale to texts. */
  readonly texts: Readonly<Record<string, RevisionText>>;
  readonly categoryIds: readonly string[];
  readonly taxCategoryCode: string;
  readonly attributeValues: Readonly<Record<string, unknown>>;
  readonly variants: readonly RevisionVariant[];
  /** Photo ids in order; the first is the primary. */
  readonly imageIds: readonly string[];
}

export interface RevisionDecision {
  readonly outcome: string;
  readonly publishKind: string | null;
  readonly supersededCause: string | null;
  readonly reasonCode: string | null;
  readonly decidedByKind: string;
  readonly decidedAt: string;
}

export interface RevisionHistoryEntry {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly kind: string;
  readonly authorKind: string;
  readonly submittedAt: string;
  readonly decision: RevisionDecision | null;
}

/** GET catalog/admin/products/:p/revisions/:r */
export interface RevisionRead {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly status: string;
  /** The product version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly state: 'pending' | 'published' | 'closed';
  readonly firstPublication: boolean;
  readonly reasons: readonly string[];
  /** The checks an approval must confirm; empty unless pending. */
  readonly requiredChecks: readonly string[];
  readonly warnings: readonly string[];
  readonly revision: RevisionContent;
  /** The published revision; null before the first publication. */
  readonly published: RevisionContent | null;
  /** Newest first, at most 50. */
  readonly history: readonly RevisionHistoryEntry[];
}

/** One photo of GET .../revisions/:r/images. */
export interface RevisionImage {
  readonly imageId: string;
  /** 1 is the primary photo. */
  readonly position: number;
  readonly state: 'clean' | 'taken-down';
  readonly width: number;
  readonly height: number;
}

export interface RevisionImageList {
  readonly images: readonly RevisionImage[];
}
