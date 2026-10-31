import 'server-only';
import type { Brand, CertificationBadge, Money, ProductDetail } from '../storefront/types.ts';
import { plainText } from './defaults.ts';
import { imageUrl } from './metadata.ts';

// Structured data (JSON-LD) of the buyer site (SEO plan, package 3). Pure builders that return
// plain schema.org nodes from the same read object the page renders, so the price and the
// availability in the markup can never differ from what the buyer sees. The page decides whether
// markup is given at all: only on a listed host (an origin is known) and only on an indexable page.

/** A schema.org node; `@context` is added once by {@link jsonLdText}. */
export type JsonLdNode = { readonly '@type': string } & Readonly<Record<string, unknown>>;

const SCHEMA = 'https://schema.org';

/** Google reads at most this many characters of a description; longer is cut, never refused. */
const DESCRIPTION_MAX = 5000;

/**
 * The business facts of the store (legal name, ABN, address, contact, return and shipping
 * policies). Not built in this package: they come from the Market's settings.
 * TODO(admin S5): fill from the S1/S5 store settings and pass to {@link homeStructuredData}.
 */
export interface StoreBusinessInfo {
  readonly legalName?: string;
  readonly taxID?: string;
}

/**
 * The store's logo for the OnlineStore node: an image of at least 112x112 px. None yet (the brand
 * is not settled, the PWA icons are app icons, not a logo), so the node has no `logo`.
 */
export const STORE_LOGO: string | undefined = undefined;

/**
 * The JSON text for a `<script type="application/ld+json">`: one node, or several as `@graph`.
 * `<`, `>` and `&` are written as `<`, `>` and `&`, so no page, seller or admin text
 * can close the script or open a comment; U+2028 and U+2029 likewise. The JSON value is the same.
 */
export function jsonLdText(data: JsonLdNode | readonly JsonLdNode[]): string {
  const body = Array.isArray(data)
    ? { '@context': SCHEMA, '@graph': data }
    : { '@context': SCHEMA, ...(data as JsonLdNode) };
  return JSON.stringify(body).replace(
    /[<>&\u2028\u2029]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Minor units as a decimal string ("12.50"), with the currency's own number of digits. */
export function decimalPrice(money: Money): string {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency: money.currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  if (digits === 0) return String(money.amount);
  const whole = Math.trunc(money.amount / 10 ** digits);
  const fraction = String(money.amount % 10 ** digits).padStart(digits, '0');
  return `${whole}.${fraction}`;
}

/** A site path on the origin as an absolute URL; segments are already encoded by the caller. */
const absolute = (path: string, origin: string): string => new URL(path, origin).href;

/**
 * A certificate for `hasCertification`: only an outside body's certificate from the offer's
 * badges, which certification builds from evaluateClaim (ADR-0012, CAT-41). A seller's own
 * declaration is not a certificate; a badge without an issuer cannot name `issuedBy`, so it is
 * left out. Product text never feeds this.
 */
function certificationOf(badge: CertificationBadge): JsonLdNode | null {
  if (badge.sellerClaim !== false || badge.issuer === undefined) return null;
  return {
    '@type': 'Certification',
    name: badge.label,
    issuedBy: { '@type': 'Organization', name: badge.issuer },
    ...(badge.validUntil === undefined ? {} : { expires: badge.validUntil }),
  };
}

/**
 * The Product node of a product page (merchant listing): ONE Offer, the buy box's offer, never an
 * AggregateOffer. None when that offer has no positive price.
 *
 * @param url the page's absolute canonical URL
 */
export function productStructuredData(
  product: ProductDetail,
  origin: string,
  url: string,
): JsonLdNode | null {
  const [offer] = product.offers;
  if (!Number.isSafeInteger(offer.price.amount) || offer.price.amount <= 0) return null;
  const price = decimalPrice(offer.price);
  const images = product.photos.flatMap((photo) => imageUrl(photo, origin) ?? []);
  const description = Array.from(plainText(product.description)).slice(0, DESCRIPTION_MAX).join('');
  const certifications = offer.certifications.flatMap((badge) => certificationOf(badge) ?? []);
  return {
    '@type': 'Product',
    name: plainText(product.name),
    ...(images.length === 0 ? {} : { image: images }),
    ...(description === '' ? {} : { description }),
    ...(certifications.length === 0 ? {} : { hasCertification: certifications }),
    // The brand entity of the product (its active brand's page), never a text a seller typed.
    ...(product.brand === undefined
      ? {}
      : {
          brand: {
            '@type': 'Brand',
            name: plainText(product.brand.name),
            url: absolute(`/brands/${encodeURIComponent(product.brand.slug)}`, origin),
          },
        }),
    offers: {
      '@type': 'Offer',
      url,
      price,
      priceCurrency: offer.price.currency,
      // Every price on the page is shown "including GST" (inferred in the plan; see the PR).
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price,
        priceCurrency: offer.price.currency,
        valueAddedTaxIncluded: true,
      },
      // Same rule as the buy button: a limit of 0 units is out of stock.
      availability: `${SCHEMA}/${offer.lowStock === 0 ? 'OutOfStock' : 'InStock'}`,
      itemCondition: `${SCHEMA}/NewCondition`,
      seller: {
        '@type': 'Organization',
        name: offer.seller.name,
        url: absolute(`/s/${encodeURIComponent(offer.seller.id)}`, origin),
      },
    },
  };
}

/** One visible crumb: a page of the site, or the current page (no path). */
export interface BreadcrumbStep {
  readonly name: string;
  readonly path?: string;
}

/**
 * The BreadcrumbList of the visible crumbs, in order. The last step may have no path; a list of
 * fewer than two steps is none. "Browse products" opens a panel, not a page: callers leave it out.
 */
export function breadcrumbStructuredData(
  steps: readonly BreadcrumbStep[],
  origin: string,
): JsonLdNode | null {
  if (steps.length < 2) return null;
  return {
    '@type': 'BreadcrumbList',
    itemListElement: steps.map((step, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: plainText(step.name),
      ...(step.path === undefined ? {} : { item: absolute(step.path, origin) }),
    })),
  };
}

/**
 * A product page's nodes: the Product and its BreadcrumbList. None at all when the product has
 * no Product node (no positive price).
 */
export function productPageStructuredData(
  product: ProductDetail,
  crumbs: readonly BreadcrumbStep[],
  origin: string,
  url: string,
): JsonLdNode[] {
  const node = productStructuredData(product, origin, url);
  if (node === null) return [];
  const trail = breadcrumbStructuredData(crumbs, origin);
  return trail === null ? [node] : [node, trail];
}

/**
 * The home page's WebSite and OnlineStore nodes. Business facts are not built here: see
 * {@link StoreBusinessInfo}; until S5 the slot stays empty.
 */
export function homeStructuredData(
  store: string,
  origin: string,
  business: StoreBusinessInfo = {},
): JsonLdNode[] {
  const url = absolute('/', origin);
  const logo = imageUrl(STORE_LOGO, origin);
  return [
    { '@type': 'WebSite', name: store, url },
    {
      '@type': 'OnlineStore',
      name: store,
      url,
      ...(logo === undefined ? {} : { logo }),
      ...business,
    },
  ];
}

/**
 * A brand page's nodes: the Brand and its BreadcrumbList. The brand's `url` is its canonical page;
 * `logo` only when the brand has a logo an https or site image can be built for.
 *
 * @param url the page's absolute canonical URL
 */
export function brandPageStructuredData(
  brand: Brand,
  crumbs: readonly BreadcrumbStep[],
  origin: string,
  url: string,
): JsonLdNode[] {
  const logo = imageUrl(brand.logo?.src, origin);
  const description = brand.summary === undefined ? '' : plainText(brand.summary);
  const node: JsonLdNode = {
    '@type': 'Brand',
    name: plainText(brand.name),
    url,
    ...(description === '' ? {} : { description }),
    ...(logo === undefined ? {} : { logo }),
  };
  const trail = breadcrumbStructuredData(crumbs, origin);
  return trail === null ? [node] : [node, trail];
}
