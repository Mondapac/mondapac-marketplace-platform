import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';

// In-app notices (in-app notifications package 1). A notice says what happened, as a kind and a
// few ids or counts; the panel renders the text in its own language and builds the link to the
// item from the same fields. Nothing personal is kept: no name, no address, no email.

/** A notice stays this many days; older ones are neither shown nor kept. */
export const NOTICE_RETENTION_DAYS = 90;
/**
 * At most this many notices per seller and kind; the oldest beyond it are deleted (a cap per kind,
 * so a flood of one kind, low stock say, never pushes the seller's orders out).
 */
export const NOTICES_PER_SELLER = 200;
/** At most this many admin notices per Market and kind; the oldest beyond it are deleted. */
export const ADMIN_NOTICES_PER_MARKET = 200;
/** One page of the list. */
export const NOTICE_PAGE_SIZE = 20;

/** A new paid seller order: the seller order id (the link) and the number of items in it. */
export const SELLER_ORDER_PAID = 'seller.order-paid';

export interface SellerOrderPaidParams {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly items: number;
}

// The other seller notices (package 4): what happened to the seller's stock, certificates,
// catalog, prices and access. Each holds the ids of its item (the panel builds the link) and
// enums or counts; never a name, a reason text or an amount. The enum lists copy the publishing
// module's event vocabulary; a contract test fails when one drifts, since a value missing here
// would dead-letter the event.

/** A sell unit's stock fell to low. */
export const SELLER_LOW_STOCK = 'seller.low-stock';
/** A reviewer approved, declined or asked for changes on a certificate. */
export const SELLER_CERTIFICATE_DECIDED = 'seller.certificate-decided';
/** An approved certificate expires in a few days (a warning threshold of the Market). */
export const SELLER_CERTIFICATE_EXPIRING = 'seller.certificate-expiring';
/** A certificate expired or was revoked. */
export const SELLER_CERTIFICATE_ENDED = 'seller.certificate-ended';
/** An admin answered the seller's "my issuer is not listed" request. */
export const SELLER_ISSUER_REQUEST_ANSWERED = 'seller.issuer-request-answered';
/** An Offer was published. */
export const SELLER_OFFER_PUBLISHED = 'seller.offer-published';
/** A reviewer asked for changes to an Offer. */
export const SELLER_OFFER_CHANGES_REQUESTED = 'seller.offer-changes-requested';
/** A product revision of the seller was published. */
export const SELLER_PRODUCT_PUBLISHED = 'seller.product-published';
/** A reviewer sent a product revision of the seller back. */
export const SELLER_PRODUCT_CHANGES_REQUESTED = 'seller.product-changes-requested';
/** A certification tag of an Offer was suspended, removed or restored. */
export const SELLER_OFFER_TAG_CHANGED = 'seller.offer-tag-changed';
/** An image of the seller's product was taken down. */
export const SELLER_IMAGE_TAKEN_DOWN = 'seller.image-taken-down';
/** A held price was approved or rejected. */
export const SELLER_PRICE_HOLD_DECIDED = 'seller.price-hold-decided';
/** The seller's access was approved or reinstated. */
export const SELLER_ACCESS_CHANGED = 'seller.access-changed';
/** A payment of the seller's order was disputed; its money is on hold (package 8b). Ids only. */
export const SELLER_ORDER_DISPUTED = 'seller.order-disputed';

export const CERTIFICATE_OUTCOMES = ['approved', 'changes-requested', 'declined'] as const;
export const CERTIFICATE_END_CAUSES = ['expired', 'revoked'] as const;
export const ISSUER_REQUEST_OUTCOMES = ['issuer-added', 'not-accepted'] as const;
export const CHANGE_REASONS = [
  'content-unclear',
  'description-claim',
  'sku-or-condition',
  'handling-unclear',
  'other',
] as const;
export const TAG_CHANGES = ['suspended', 'removed', 'restored'] as const;
export const IMAGE_TAKEDOWN_REASONS = [
  'certification-mark',
  'misleading',
  'rights',
  'unsafe-or-illegal',
  'other',
] as const;
export const HOLD_OUTCOMES = ['approved', 'rejected'] as const;
export const PRICE_KINDS = ['regular', 'special'] as const;
export const ACCESS_CHANGES = ['approved', 'reinstated'] as const;

/** Every kind a seller may see. */
export type SellerNoticeKind =
  | typeof SELLER_ORDER_PAID
  | typeof SELLER_LOW_STOCK
  | typeof SELLER_CERTIFICATE_DECIDED
  | typeof SELLER_CERTIFICATE_EXPIRING
  | typeof SELLER_CERTIFICATE_ENDED
  | typeof SELLER_ISSUER_REQUEST_ANSWERED
  | typeof SELLER_OFFER_PUBLISHED
  | typeof SELLER_OFFER_CHANGES_REQUESTED
  | typeof SELLER_PRODUCT_PUBLISHED
  | typeof SELLER_PRODUCT_CHANGES_REQUESTED
  | typeof SELLER_OFFER_TAG_CHANGED
  | typeof SELLER_IMAGE_TAKEN_DOWN
  | typeof SELLER_PRICE_HOLD_DECIDED
  | typeof SELLER_ACCESS_CHANGED
  | typeof SELLER_ORDER_DISPUTED;
export const SELLER_NOTICE_KINDS: readonly SellerNoticeKind[] = [
  SELLER_ORDER_PAID,
  SELLER_LOW_STOCK,
  SELLER_CERTIFICATE_DECIDED,
  SELLER_CERTIFICATE_EXPIRING,
  SELLER_CERTIFICATE_ENDED,
  SELLER_ISSUER_REQUEST_ANSWERED,
  SELLER_OFFER_PUBLISHED,
  SELLER_OFFER_CHANGES_REQUESTED,
  SELLER_PRODUCT_PUBLISHED,
  SELLER_PRODUCT_CHANGES_REQUESTED,
  SELLER_OFFER_TAG_CHANGED,
  SELLER_IMAGE_TAKEN_DOWN,
  SELLER_PRICE_HOLD_DECIDED,
  SELLER_ACCESS_CHANGED,
  SELLER_ORDER_DISPUTED,
];

/** The seller kinds that ring the new-order sound (plan 6b): orders only. */
export const SELLER_RINGING_KINDS: readonly SellerNoticeKind[] = [SELLER_ORDER_PAID];

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

/**
 * The params of a seller kind other than the order (package 4): ids, enums and counts as
 * {@link PARAM_SHAPES} lists them for the kind.
 */
export type SellerItemParams = Readonly<Record<string, string | number>>;

export type NoticeParams =
  | SellerOrderPaidParams
  | SellerItemParams
  | SellerCertificateSubmittedParams
  | ProductRevisionSubmittedParams
  | SellerFileSubmittedParams
  | PriceHoldOpenedParams;

interface ParamShape {
  readonly ids: readonly string[];
  readonly enums: Readonly<Record<string, readonly string[]>>;
  /** Whole numbers, zero or more. */
  readonly counts?: readonly string[];
}

/**
 * The id, enum and count fields each kind keeps (but the order notice, read on its own); nothing
 * else is read back.
 */
const PARAM_SHAPES: Readonly<
  Record<Exclude<SellerNoticeKind, typeof SELLER_ORDER_PAID> | AdminNoticeKind, ParamShape>
> = {
  [SELLER_LOW_STOCK]: { ids: ['offerId', 'variantId'], enums: {}, counts: ['onlyLeft'] },
  [SELLER_CERTIFICATE_DECIDED]: {
    ids: ['sellerCertificationId'],
    enums: { outcome: CERTIFICATE_OUTCOMES },
  },
  [SELLER_CERTIFICATE_EXPIRING]: {
    ids: ['sellerCertificationId'],
    enums: {},
    counts: ['days'],
  },
  [SELLER_CERTIFICATE_ENDED]: {
    ids: ['sellerCertificationId'],
    enums: { cause: CERTIFICATE_END_CAUSES },
  },
  [SELLER_ISSUER_REQUEST_ANSWERED]: {
    ids: ['issuerRequestId'],
    enums: { outcome: ISSUER_REQUEST_OUTCOMES },
  },
  [SELLER_OFFER_PUBLISHED]: { ids: ['offerId', 'productId'], enums: {} },
  [SELLER_OFFER_CHANGES_REQUESTED]: {
    ids: ['offerId', 'productId'],
    enums: { reason: CHANGE_REASONS },
  },
  [SELLER_PRODUCT_PUBLISHED]: { ids: ['productId', 'revisionId'], enums: {} },
  [SELLER_PRODUCT_CHANGES_REQUESTED]: {
    ids: ['productId', 'revisionId'],
    enums: { reason: CHANGE_REASONS },
  },
  [SELLER_OFFER_TAG_CHANGED]: { ids: ['offerId', 'tagId'], enums: { change: TAG_CHANGES } },
  [SELLER_IMAGE_TAKEN_DOWN]: {
    ids: ['productId', 'imageId'],
    enums: { reason: IMAGE_TAKEDOWN_REASONS },
  },
  [SELLER_PRICE_HOLD_DECIDED]: {
    ids: ['offerId', 'variantId', 'recordId'],
    enums: { outcome: HOLD_OUTCOMES, priceKind: PRICE_KINDS },
  },
  [SELLER_ACCESS_CHANGED]: { ids: [], enums: { change: ACCESS_CHANGES } },
  [SELLER_ORDER_DISPUTED]: { ids: ['sellerOrderId', 'orderId'], enums: {} },
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
  if (!Object.hasOwn(PARAM_SHAPES, kind)) return null;
  const shape: ParamShape = PARAM_SHAPES[kind as keyof typeof PARAM_SHAPES];
  const params: Record<string, string | number> = {};
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
  for (const field of shape.counts ?? []) {
    const count = value[field];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
    params[field] = count;
  }
  return params;
}
