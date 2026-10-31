import { formatMoney } from '../format/money.ts';
import { isBrandSlug } from './brands.ts';
import { imageIdsOf, type PhotoUrl } from './photos.ts';
import type { CertificationBadge, Money, ProductDetail, ProductOffer } from './types.ts';

// The product page's read of the API (`GET search/product-detail/:productId`, PR #450) and its
// mapping to the page's own shape. What the API does not have yet stays empty and the page hides
// it: specifications, the regular price beside a special, similar products, the seller's city, "selling since",
// ratings and delivery window.

/** Money as the API sends it: minor units as a decimal string. */
interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

export interface ProductDetailBody {
  readonly productId: string;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly categoryIds: readonly string[];
  /** The product's active brand (`slug`, `name`) or null; untrusted, read through {@link brandRefOf}. */
  readonly brand?: unknown;
  /** Photo references (`imageId`, size, alt), at most 8; read through {@link imageIdsOf}. */
  readonly images?: unknown;
  readonly offers: readonly {
    readonly offerId: string;
    readonly sellerId: string;
    readonly seller: {
      readonly storeName: string | null;
      readonly minimumOrder?: MoneyBody | null;
    };
    /** Certification badges (live from certification); untrusted, read through {@link badgesOf}. */
    readonly badges?: unknown;
    readonly units: readonly {
      readonly variantId: string;
      readonly label: string | null;
      readonly price: MoneyBody;
      readonly taxInclusive: boolean;
      readonly special: { readonly endsAt: string } | null;
      readonly stock: {
        readonly status: 'in-stock' | 'low' | 'out';
        readonly onlyLeft: number | null;
      };
    }[];
  }[];
}

/** The texts the mapping needs, in the page's language. */
export interface ProductDetailLabels {
  readonly minimum: (amount: string) => string;
  readonly noMinimum: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether a path id can name a product of the API (catalog ids are UUIDs). */
export const isProductId = (id: string): boolean => UUID.test(id);

const TYPE_CODE = /^[a-z][a-z0-9-]{1,31}$/u;
const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u;
const MAX_BADGES = 10;
const MAX_TEXT = 200;

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT;

/** A real calendar date written `YYYY-MM-DD`. */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * One badge of the API, checked field by field: a badge with any field missing, of the wrong type
 * or out of shape is dropped whole, never shown in part.
 */
function badgeOf(raw: unknown): CertificationBadge | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.typeCode !== 'string' || !TYPE_CODE.test(b.typeCode)) return null;
  if (!isText(b.typeName)) return null;
  if (b.basis !== 'SELLER' && b.basis !== 'MANUFACTURER') return null;
  if (typeof b.sellerClaim !== 'boolean' || typeof b.verifiedWithIssuer !== 'boolean') return null;
  if (b.issuerName !== null && !isText(b.issuerName)) return null;
  if (b.validUntilLocalDate !== null && !isIsoDate(b.validUntilLocalDate)) return null;
  return {
    type: b.typeCode,
    label: b.typeName,
    basis: b.basis,
    sellerClaim: b.sellerClaim,
    verifiedWithIssuer: b.verifiedWithIssuer,
    ...(b.issuerName === null ? {} : { issuer: b.issuerName }),
    ...(b.validUntilLocalDate === null ? {} : { validUntil: b.validUntilLocalDate }),
  };
}

/**
 * The badges of an offer from the untrusted body: absent or not a list is none; a malformed badge
 * is dropped; one badge per type (the first), at most {@link MAX_BADGES}.
 */
export function badgesOf(raw: unknown): CertificationBadge[] {
  if (!Array.isArray(raw)) return [];
  const out: CertificationBadge[] = [];
  for (const item of raw as unknown[]) {
    const badge = badgeOf(item);
    if (badge === null || out.some((seen) => seen.type === badge.type)) continue;
    out.push(badge);
    if (out.length === MAX_BADGES) break;
  }
  return out;
}

/**
 * The brand of the product from the untrusted body: a slug of the brand page's shape and a name, or
 * none (absent, null or malformed is no brand, never half a link).
 */
export function brandRefOf(raw: unknown): ProductDetail['brand'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { slug, name } = raw as Record<string, unknown>;
  return isBrandSlug(slug) && isText(name) ? { slug, name } : undefined;
}

/** API money as the page's; null when the amount is not a safe whole number of minor units. */
function moneyOf(body: MoneyBody): Money | null {
  if (!/^[0-9]{1,15}$/u.test(body.amount)) return null;
  return { amount: Number(body.amount), currency: body.currency };
}

/**
 * The page's product from the API answer, or undefined when no offer can be shown. An offer is
 * shown with its first priced Variant (the page has no Variant picker yet); a seller without a
 * public store name is left out. "Only N left" is the API's `onlyLeft` in the low band; out of
 * stock is a limit of 0, so Add to cart is disabled.
 */
export function productDetailOf(
  body: ProductDetailBody,
  locale: string,
  labels: ProductDetailLabels,
  photo: PhotoUrl | null = null,
): ProductDetail | undefined {
  const offers = body.offers.flatMap((offer): ProductOffer[] => {
    const unit = offer.units[0];
    const name = offer.seller.storeName;
    const price = unit === undefined ? null : moneyOf(unit.price);
    if (unit === undefined || price === null || name === null) return [];
    const minimum = offer.seller.minimumOrder;
    const badges = badgesOf(offer.badges);
    const minimumMoney = minimum === undefined || minimum === null ? null : moneyOf(minimum);
    return [
      {
        id: offer.offerId,
        variantId: unit.variantId,
        // The card line "<type> certificate checked" is for a certificate the platform checked, not a
        // seller's own declaration, and not a manufacturer's.
        seller: {
          id: offer.sellerId,
          name,
          certificates: badges
            .filter((badge) => badge.basis === 'SELLER' && badge.sellerClaim !== true)
            .map((badge) => ({ type: badge.type, name: badge.label })),
        },
        price,
        certifications: badges,
        ...(unit.stock.status === 'out'
          ? { lowStock: 0 }
          : unit.stock.status === 'low' && unit.stock.onlyLeft !== null
            ? { lowStock: unit.stock.onlyLeft }
            : {}),
        ...(minimum === null
          ? { minimumOrder: labels.noMinimum }
          : minimumMoney === null
            ? {}
            : { minimumOrder: labels.minimum(formatMoney(minimumMoney, locale, { whole: true })) }),
      },
    ];
  });
  const [first, ...rest] = offers;
  if (first === undefined) return undefined;
  const ids = photo === null ? [] : imageIdsOf(body.images);
  // Both sizes or neither: an id the builder refuses drops that photo from both lists.
  const shots = ids.flatMap((id) => {
    const large = photo?.(body.productId, id, 'large');
    const thumb = photo?.(body.productId, id, 'thumb');
    return large === undefined || thumb === undefined ? [] : [{ large, thumb }];
  });
  return {
    id: body.productId,
    name: body.name,
    category: body.categoryIds[0] ?? '',
    description: body.description ?? body.shortDescription ?? '',
    specifications: [],
    ...(brandRefOf(body.brand) === undefined ? {} : { brand: brandRefOf(body.brand)! }),
    photos: shots.map((shot) => shot.large),
    ...(shots.length > 1 ? { photoThumbs: shots.map((shot) => shot.thumb) } : {}),
    offers: [first, ...rest],
    similar: [],
  };
}
