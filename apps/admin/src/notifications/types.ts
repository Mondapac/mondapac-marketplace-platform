// Answers of the admin notice routes (apps/api, in-app notifications package 3). Notices carry
// ids only: no seller, store or product names.

export const CERTIFICATE_SUBMITTED = 'admin.seller-certificate-submitted';
export const PRODUCT_REVISION_SUBMITTED = 'admin.product-revision-submitted';
export const SELLER_FILE_SUBMITTED = 'admin.seller-file-submitted';
export const PRICE_HOLD_OPENED = 'admin.price-hold-opened';
export const DELIVERY_FALLBACK_OVER_CAP = 'admin.delivery-fallback-over-cap';
export const PLATFORM_IMPORT_FINISHED = 'admin.platform-import-finished';
export const REVIEW_HELD = 'admin.review-held';
export const REVIEW_REPORTED = 'admin.review-reported';
export const SELLER_REFUND_LIMIT_REACHED = 'admin.seller-refund-limit-reached';

/** Every admin kind asks for a review, so every one plays the sound when it is switched on. */
export const RINGING_KINDS: ReadonlySet<string> = new Set([
  CERTIFICATE_SUBMITTED,
  PRODUCT_REVISION_SUBMITTED,
  SELLER_FILE_SUBMITTED,
  PRICE_HOLD_OPENED,
  DELIVERY_FALLBACK_OVER_CAP,
  PLATFORM_IMPORT_FINISHED,
  REVIEW_HELD,
  REVIEW_REPORTED,
  SELLER_REFUND_LIMIT_REACHED,
]);

/**
 * The permission behind each kind: the API lists a notice only to an admin who holds it, and
 * the bell is shown to an admin who holds at least one.
 */
export const NOTICES_PERMISSIONS: readonly string[] = [
  'certification.seller-certificate.review',
  'catalog.product.approve',
  'sellers.seller-file.review',
  'pricing.price-hold.decide',
  'shipping.delivery-settings.view',
  'catalog.platform-import.run',
  'reviews.moderation.queue',
  'ordering.refund-limits.view',
];

/** Whether the admin holds a permission behind at least one notice kind (shows the bell). */
export function showsNoticeBell(permissionKeys: readonly string[]): boolean {
  return NOTICES_PERMISSIONS.some((key) => permissionKeys.includes(key));
}

export interface AdminNoticeParams {
  /** admin.seller-certificate-submitted and admin.seller-file-submitted. */
  readonly sellerId?: string;
  readonly sellerCertificationId?: string;
  readonly submission?: 'initial' | 'resubmission' | 'renewal';
  /** admin.product-revision-submitted. */
  readonly productId?: string;
  readonly revisionId?: string;
  /** admin.seller-file-submitted. */
  readonly fileKind?: 'onboarding' | 'identity-change';
  /** admin.price-hold-opened. */
  readonly recordId?: string;
  readonly offerId?: string;
  readonly direction?: 'up' | 'down';
  /** admin.delivery-fallback-over-cap (sellerId above too). */
  readonly sellerOrderId?: string;
  /** admin.platform-import-finished. */
  readonly importId?: string;
  readonly outcome?: 'completed' | 'stopped';
  /** admin.review-held and admin.review-reported (the report adds nothing else). */
  readonly reviewId?: string;
  /** admin.seller-refund-limit-reached (sellerId above too): which cap stopped the refund. */
  readonly limit?: 'count' | 'amount' | 'unset';
}

export interface AdminNotice {
  readonly id: string;
  readonly kind: string;
  readonly params: AdminNoticeParams;
  readonly createdAt: string;
  readonly read: boolean;
  /** Always null on the admin routes: kept for the shape the seller routes share. */
  readonly customerShortName?: null;
}
