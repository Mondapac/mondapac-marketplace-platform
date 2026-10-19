import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';

// In-app notices (in-app notifications package 1). A notice says what happened, as a kind and a
// few ids or counts; the panel renders the text in its own language and builds the link to the
// item from the same fields. Nothing personal is kept: no name, no address, no email.

/** A notice stays this many days; older ones are neither shown nor kept. */
export const NOTICE_RETENTION_DAYS = 90;
/** At most this many notices per seller; the oldest beyond it are deleted. */
export const NOTICES_PER_SELLER = 200;
/** At most this many admin notices per Market; the oldest beyond it are deleted. */
export const ADMIN_NOTICES_PER_MARKET = 200;
/** One page of the list. */
export const NOTICE_PAGE_SIZE = 20;

/** A new paid seller order: the seller order id (the link) and the number of items in it. */
export const SELLER_ORDER_PAID = 'seller.order-paid';

export interface SellerOrderPaidParams {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly items: number;
}

/** Every kind a seller may see, with what its params hold. */
export type SellerNoticeKind = typeof SELLER_ORDER_PAID;
export const SELLER_NOTICE_KINDS: readonly SellerNoticeKind[] = [SELLER_ORDER_PAID];

// Admin approval notices (package 3): something waits in a review queue of the Market. One notice
// per Market, shown to every admin who holds the kind's permission when reading.

/** A seller submitted a certificate for review. */
export const ADMIN_SELLER_CERTIFICATE_SUBMITTED = 'admin.seller-certificate-submitted';
/** A seller's product revision waits for review (an auto-published one makes no notice). */
export const ADMIN_PRODUCT_REVISION_SUBMITTED = 'admin.product-revision-submitted';
/** A seller's business file (a new application or changed details) waits for review. */
export const ADMIN_SELLER_FILE_SUBMITTED = 'admin.seller-file-submitted';
/** A price was held for approval. */
export const ADMIN_PRICE_HOLD_OPENED = 'admin.price-hold-opened';

export const CERTIFICATE_SUBMISSIONS = ['initial', 'resubmission', 'renewal'] as const;
export const SELLER_FILE_KINDS = ['onboarding', 'identity-change'] as const;
export const HOLD_DIRECTIONS = ['up', 'down'] as const;

export interface SellerCertificateSubmittedParams {
  readonly sellerId: Id<'Seller'>;
  readonly sellerCertificationId: Id<'SellerCertification'>;
  readonly submission: (typeof CERTIFICATE_SUBMISSIONS)[number];
}

export interface ProductRevisionSubmittedParams {
  readonly productId: Id<'Product'>;
  readonly revisionId: Id<'ProductRevision'>;
}

export interface SellerFileSubmittedParams {
  readonly sellerId: Id<'Seller'>;
  readonly fileKind: (typeof SELLER_FILE_KINDS)[number];
}

export interface PriceHoldOpenedParams {
  readonly recordId: Id<'PriceRecord'>;
  readonly offerId: Id<'Offer'>;
  readonly direction: (typeof HOLD_DIRECTIONS)[number];
}

/** Every kind an admin may see. */
export type AdminNoticeKind =
  | typeof ADMIN_SELLER_CERTIFICATE_SUBMITTED
  | typeof ADMIN_PRODUCT_REVISION_SUBMITTED
  | typeof ADMIN_SELLER_FILE_SUBMITTED
  | typeof ADMIN_PRICE_HOLD_OPENED;
export const ADMIN_NOTICE_KINDS: readonly AdminNoticeKind[] = [
  ADMIN_SELLER_CERTIFICATE_SUBMITTED,
  ADMIN_PRODUCT_REVISION_SUBMITTED,
  ADMIN_SELLER_FILE_SUBMITTED,
  ADMIN_PRICE_HOLD_OPENED,
];

export type NoticeParams =
  | SellerOrderPaidParams
  | SellerCertificateSubmittedParams
  | ProductRevisionSubmittedParams
  | SellerFileSubmittedParams
  | PriceHoldOpenedParams;

/** The id fields and the enum fields each admin kind keeps; nothing else is read back. */
const ADMIN_PARAM_SHAPES: Readonly<
  Record<
    AdminNoticeKind,
    {
      readonly ids: readonly string[];
      readonly enums: Readonly<Record<string, readonly string[]>>;
    }
  >
> = {
  [ADMIN_SELLER_CERTIFICATE_SUBMITTED]: {
    ids: ['sellerId', 'sellerCertificationId'],
    enums: { submission: CERTIFICATE_SUBMISSIONS },
  },
  [ADMIN_PRODUCT_REVISION_SUBMITTED]: { ids: ['productId', 'revisionId'], enums: {} },
  [ADMIN_SELLER_FILE_SUBMITTED]: { ids: ['sellerId'], enums: { fileKind: SELLER_FILE_KINDS } },
  [ADMIN_PRICE_HOLD_OPENED]: {
    ids: ['recordId', 'offerId'],
    enums: { direction: HOLD_DIRECTIONS },
  },
};

/**
 * Reads stored params back for one kind, keeping only the known fields. `null` when a row does
 * not have the shape its kind promises; such a row is left out rather than shown half-built.
 */
export function parseNoticeParams(kind: string, raw: unknown): NoticeParams | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (kind === SELLER_ORDER_PAID) {
    if (typeof value.sellerOrderId !== 'string') return null;
    const sellerOrderId = parseId(value.sellerOrderId);
    const items = value.items;
    if (!sellerOrderId.ok) return null;
    if (typeof items !== 'number' || !Number.isSafeInteger(items) || items < 0) return null;
    return { sellerOrderId: sellerOrderId.value as Id<'SellerOrder'>, items };
  }
  if (!Object.hasOwn(ADMIN_PARAM_SHAPES, kind)) return null;
  const shape = ADMIN_PARAM_SHAPES[kind as AdminNoticeKind];
  const params: Record<string, string> = {};
  for (const field of shape.ids) {
    const id = typeof value[field] === 'string' ? parseId(value[field]) : null;
    if (id === null || !id.ok) return null;
    params[field] = id.value;
  }
  for (const [field, allowed] of Object.entries(shape.enums)) {
    const member = value[field];
    if (typeof member !== 'string' || !allowed.includes(member)) return null;
    params[field] = member;
  }
  return params as unknown as NoticeParams;
}
