// Answers of the seller notice routes (apps/api seller-notices.controller.ts). Notices carry ids,
// enums and counts only: no names, reasons in text or amounts.

/** A paid seller order (in-app notifications package 1). */
export const ORDER_PAID = 'seller.order-paid';
// The other seller kinds (package 4).
export const LOW_STOCK = 'seller.low-stock';
export const CERTIFICATE_DECIDED = 'seller.certificate-decided';
export const CERTIFICATE_EXPIRING = 'seller.certificate-expiring';
export const CERTIFICATE_ENDED = 'seller.certificate-ended';
export const ISSUER_REQUEST_ANSWERED = 'seller.issuer-request-answered';
export const OFFER_PUBLISHED = 'seller.offer-published';
export const OFFER_CHANGES_REQUESTED = 'seller.offer-changes-requested';
export const PRODUCT_PUBLISHED = 'seller.product-published';
export const PRODUCT_CHANGES_REQUESTED = 'seller.product-changes-requested';
export const OFFER_TAG_CHANGED = 'seller.offer-tag-changed';
export const IMAGE_TAKEN_DOWN = 'seller.image-taken-down';
export const PRICE_HOLD_DECIDED = 'seller.price-hold-decided';
export const ACCESS_CHANGED = 'seller.access-changed';

/** The kinds that play the new-order sound (plan 6b): orders only. */
export const RINGING_KINDS: ReadonlySet<string> = new Set([ORDER_PAID]);

/**
 * The permission behind each group of kinds: the API lists a notice only to a member who holds
 * it, and the bell is shown to a member who holds at least one. `identity.team-member.invite`
 * stands for the Seller Owner (the access notices).
 */
export const NOTICES_PERMISSIONS: readonly string[] = [
  'ordering.seller-order.view',
  'inventory.stock.view',
  'certification.own-certificate.view',
  'catalog.own-product.view',
  'pricing.price.view',
  'identity.team-member.invite',
];

/** Whether the member holds a permission behind at least one notice kind (shows the bell). */
export function showsNoticeBell(permissionKeys: readonly string[]): boolean {
  return NOTICES_PERMISSIONS.some((key) => permissionKeys.includes(key));
}

export interface NoticeParams {
  /** seller.order-paid: the seller order and its number of items. No customer data. */
  readonly sellerOrderId?: string;
  readonly items?: number;
  /** Offer, product and price kinds. */
  readonly offerId?: string;
  readonly productId?: string;
  readonly variantId?: string;
  readonly revisionId?: string;
  readonly recordId?: string;
  readonly tagId?: string;
  readonly imageId?: string;
  /** seller.low-stock: units left. */
  readonly onlyLeft?: number;
  /** Certificate kinds. */
  readonly sellerCertificationId?: string;
  readonly issuerRequestId?: string;
  /** seller.certificate-expiring: days to the expiry. */
  readonly days?: number;
  /** The enums of each kind (see apps/api domain/in-app-notice.ts). */
  readonly outcome?: string;
  readonly cause?: string;
  readonly reason?: string;
  readonly change?: string;
  readonly priceKind?: string;
}

export interface Notice {
  readonly id: string;
  readonly kind: string;
  readonly params: NoticeParams;
  readonly createdAt: string;
  readonly read: boolean;
}

/** A notice of the list: seller.order-paid adds the customer's short name ("Maryam R."). */
export interface ListedNotice extends Notice {
  /** Null without identity.customer-short-name.view, or when the customer gave no name. */
  readonly customerShortName?: string | null;
}

export interface NoticePage {
  readonly items: readonly ListedNotice[];
  readonly next: string | null;
}

export interface UnreadNotices {
  readonly unread: number;
  readonly newest: Notice | null;
}
