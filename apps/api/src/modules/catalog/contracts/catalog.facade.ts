import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** At most this many keys per batch call; a larger call is refused whole (catalog design 9.1, L7). */
export const MAX_FACADE_BATCH = 200;

export type OfferStatus =
  'draft' | 'pending-first-publish' | 'changes-needed' | 'published' | 'deleted';

export type SellUnitState = 'proposed' | 'published';

/** One variant that may carry a price or stock (catalog design 9.1; M-1). */
export interface SellUnit {
  readonly variantId: Id<'Variant'>;
  readonly state: SellUnitState;
}

/**
 * What `pricing` and `inventory` may know of one Offer. Ids, codes and flags only: no price, no
 * stock number, no Cost and no "sellable now" (AC 6). A `deleted` Offer is present with
 * `status: 'deleted'` and no sell units.
 */
export interface OfferSellUnits {
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  readonly status: OfferStatus;
  readonly listed: boolean;
  readonly sellUnits: readonly SellUnit[];
}

/**
 * Per distinct requested Offer id found in the context's Market. An unknown id and an id of
 * another Market are byte-identical: both are **absent** from the map. Callers treat absent as
 * not sellable (pricing P-1, cart K-1).
 */
export type OfferSellUnitsMap = ReadonlyMap<Id<'Offer'>, OfferSellUnits>;

/** One (Offer, Variant) a caller wants a display label for. */
export interface SellUnitKey {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/**
 * What `sellUnitLabels` gives per key: the PUBLISHED product name and the PUBLISHED label of the
 * Variant, both seller-entered text (escape it). `variantLabel` is null when the published
 * revision has no label for that Variant (a draft label is never used).
 */
export interface SellUnitLabel {
  readonly productName: string;
  readonly variantLabel: string | null;
}

/** The answer of `sellUnitLabels`, keyed by {@link sellUnitKey}. */
export type SellUnitLabelsMap = ReadonlyMap<string, SellUnitLabel>;

/** The map key of one (Offer, Variant). */
export function sellUnitKey(key: SellUnitKey): string {
  return `${key.offerId}:${key.variantId}`;
}

/** The certification badge copied from certification's decision (CD 4.5); display only. */
export interface OfferListingBadge {
  readonly typeCode: string;
  readonly typeRevisionId: Id;
  readonly basis: 'SELLER' | 'MANUFACTURER';
  readonly sellerClaim: boolean;
  readonly issuer: { readonly id: Id; readonly displayName: string } | null;
  /** An ISO calendar date in `validUntilZone`, or null. */
  readonly validUntilLocalDate: string | null;
  readonly validUntilZone: string | null;
  readonly verifiedWithIssuer: boolean;
  readonly reviewedByPlatform: true;
}

/**
 * One certification tag of a listed Offer (catalog design 9.1), answered to the `system` caller
 * only: `active`, `rechecking` and `suspended` tags with status and basis. `badge` is present
 * only on an `active` tag whose copy is valid at the read (slice 12: catalog consumes the
 * certification revoke and expiry events, and settles them within the fan-out job's run); an
 * `anonymous` caller receives no tags (Hassan, certification revoke review, L-1). Never permission
 * to claim anything: `ordering` asks `evaluateClaims` itself (AC 14).
 */
export interface OfferListingTag {
  readonly typeCode: string;
  readonly status: 'active' | 'rechecking' | 'suspended';
  readonly basis: 'SELLER' | 'MANUFACTURER' | null;
  readonly badge: OfferListingBadge | null;
}

/**
 * What `offerListings` gives per (Offer, Variant): published state only. `listed` is catalog's own
 * state (published, product published, no off-sale cause; 4.4); `variantBelongs` says the variant
 * is a published variant of the product's published revision. Names and labels are the published
 * revision's, in the asked locale with the INTL-13 fallback (the Market's default locale, then any);
 * seller-entered text: escape it. `primaryImageId` is the first clean image of the published
 * revision (a URL is built by code). Advisory only (ADR-0025 d1): never permission to buy.
 */
export interface OfferListing {
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  readonly publishedRevisionId: Id<'ProductRevision'>;
  readonly listed: boolean;
  readonly variantBelongs: boolean;
  readonly productName: string | null;
  readonly variantLabel: string | null;
  readonly primaryImageId: Id | null;
  readonly tags: readonly OfferListingTag[];
}

/** The answer of `offerListings`, keyed by {@link sellUnitKey}. */
export type OfferListingsMap = ReadonlyMap<string, OfferListing>;

/** At most this many distinct Offers per `offerBadges` call; above it the call is refused whole. */
export const MAX_BADGE_OFFERS = 20;

/**
 * One certification badge a buyer may see on an Offer (`offerBadges`). An allow-listed copy of
 * certification's live decision (field by field), never the decision itself: no certificate,
 * version or revision id, no certificate number, holder, document, file link, reviewer, scope
 * text or policy id. `typeName` is the type's name in the Market's default locale. The text
 * fields come from certification's registries: escape them.
 */
export interface OfferBadge {
  readonly typeCode: string;
  readonly typeName: string;
  readonly basis: 'SELLER' | 'MANUFACTURER';
  /** True when the claim is the seller's own declaration (not a third party's certificate). */
  readonly sellerClaim: boolean;
  readonly issuerName: string | null;
  /** An ISO calendar date (`YYYY-MM-DD`) in the certificate's zone, or null. */
  readonly validUntilLocalDate: string | null;
  readonly verifiedWithIssuer: boolean;
}

/**
 * The answer of `offerBadges`: per Offer that carries at least one badge, its badges in type-code
 * order. An Offer with no badge, an unknown Offer, another Market's and a failure are all absent.
 */
export type OfferBadgesMap = ReadonlyMap<Id<'Offer'>, readonly OfferBadge[]>;

/** One Variant of a published product, as a buyer sees it. */
export interface PublishedProductVariant {
  readonly variantId: Id<'Variant'>;
  readonly position: number;
  readonly label: string | null;
}

/**
 * What `publishedProduct` gives: the content of a product's published revision. Texts are in the
 * asked locale with the INTL-13 fallback; seller-entered text: escape it. `categoryIds` are in the
 * revision's order and `variants` in position order, published Variants only.
 */
export interface PublishedProduct {
  readonly productId: Id<'Product'>;
  readonly publishedRevisionId: Id<'ProductRevision'>;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
  readonly variants: readonly PublishedProductVariant[];
}

/** The most photos a product page shows (the library limit of a product is the same). */
export const MAX_PUBLISHED_IMAGES = 8;

/**
 * One photo of a product's published revision, as a buyer may see it: its id and the pixel size
 * of the largest rendition (every rendition keeps the aspect ratio). Never a URL, a key or an
 * uploader: the storefront builds the URL by code from the ids.
 */
export interface PublishedImageRef {
  readonly imageId: Id<'ProductImage'>;
  readonly width: number;
  readonly height: number;
}

/** A request refused before any read: a code and the fields, never their values. */
export interface CatalogValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/** More than {@link MAX_FACADE_BATCH} keys. The call is refused whole, never truncated. */
export interface CatalogBatchTooLarge {
  readonly code: 'batch.too-large';
}

/**
 * The public facade of `catalog` (catalog design 9.1). Every method takes the caller's
 * `CallContext` first, unchanged, and is a thin call of one use case, so the gate runs. Other
 * modules inject {@link CATALOG_FACADE}; they never read catalog's tables.
 *
 * Contracts-only: until catalog slice 7 the production binding is the fail-closed placeholder
 * of ADR-0031 decision 6 and answers **absent for every key**.
 */
export interface CatalogFacade {
  /**
   * The sellers, product and sell units of each requested Offer (at most 200 ids). Advisory
   * only: the answer runs in a read-only unit (ADR-0025 d1) and is never permission to buy.
   * Two use cases behind this method: `anonymous` for a request actor, `system` for the system
   * actor. Not exposed over HTTP.
   */
  offerSellUnits(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<
    Result<OfferSellUnitsMap, AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge>
  >;

  /**
   * The published product name of each requested Offer's product, in `locale` (any locale the
   * product has when that one is missing), at most 200 ids. Rule `system`: for the order emails.
   * An absent key has no published name. The name is seller-entered text: escape it.
   */
  offerNames(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<
    Result<
      ReadonlyMap<Id<'Offer'>, string>,
      AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge
    >
  >;

  /**
   * The tax category code of the PUBLISHED revision of each requested Offer's product, at most
   * 200 ids. Rule `anonymous` (a category code is public content). An Offer that is unknown, of
   * another Market or whose product has no published revision is absent; a draft category is
   * never returned. Not exposed over HTTP.
   */
  offerTaxCategories(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<
    Result<
      ReadonlyMap<Id<'Offer'>, string>,
      AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge
    >
  >;

  /**
   * The published product name and published Variant label of each requested (Offer, Variant),
   * in `locale` (any locale present when that one is missing), at most 200 keys. Rule
   * `anonymous` (names are public content once published); callers pass their `CallContext`
   * unchanged. Only PUBLISHED content: a draft or pending name or label is never returned. A key
   * whose Offer is unknown, of another Market or without a published name is absent. Not exposed
   * over HTTP.
   */
  sellUnitLabels(
    context: CallContext,
    keys: readonly SellUnitKey[],
    locale: string,
  ): Promise<
    Result<SellUnitLabelsMap, AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge>
  >;

  /**
   * The published listing of each requested (Offer, Variant), at most 200 keys, refused whole
   * above (catalog design 9.1; Hassan L7). A key whose Offer is unknown, of another Market,
   * deleted or never published, or whose product is not published, is **absent**: nothing
   * unpublished is ever answered. Two use cases behind this method: `anonymous` for a request
   * actor (no tags: `tags` is always empty, see {@link OfferListingTag}) and `system` for the
   * system actor (tags, with the badge of a valid `active` tag). In-process only.
   */
  offerListings(
    context: CallContext,
    keys: readonly SellUnitKey[],
    locale: string,
  ): Promise<
    Result<OfferListingsMap, AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge>
  >;

  /**
   * The certification badges of each requested Offer (at most {@link MAX_BADGE_OFFERS} distinct
   * ids, else `validation.failed`). Rule `anonymous`. Built only from certification's
   * `evaluateClaims` answer asked live in this call, for the Offers that are published and on
   * sale and only for their stored `active` tags (a stored copy can only restrict, ADR-0028 d3).
   * Fail closed: any failure to ask or read answers an empty map, never a badge from stored data.
   * See {@link OfferBadge}. In-process only; not exposed over HTTP.
   */
  offerBadges(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<Result<OfferBadgesMap, AccessDenied | CatalogValidationFailed>>;

  /**
   * The published content of one product, for the buyer's product page. Rule `anonymous`: only
   * a product whose status is `published` with a published revision is answered; a draft, pending
   * or unpublished product, an unknown id and an id of another Market are all `null`, byte-identical.
   * Texts are in `locale` with the INTL-13 fallback (the Market's default locale, then the first
   * locale in code order), exactly as `offerListings` picks them; they are seller-entered text:
   * escape it. Variants are the rows of the published revision whose registry variant is
   * `published` (not proposed, not retired). No image, attribute or tag is read: images wait for
   * the media slice, and a tag is never read by an anonymous rule. In-process only.
   */
  publishedProduct(
    context: CallContext,
    productId: Id<'Product'>,
    locale: string,
  ): Promise<Result<PublishedProduct | null, AccessDenied | CatalogValidationFailed>>;

  /**
   * The photos of each requested product's PUBLISHED revision, in the revision's order, at most
   * {@link MAX_PUBLISHED_IMAGES} per product and 200 products (refused whole above). Rule
   * `anonymous`: only a product whose status is `published` with a published revision is answered,
   * and only photos that are in that revision and not taken down; a draft or pending photo, an
   * unknown product, another Market's product and a product with no photo are absent from the map.
   * Ids and pixel sizes only. In-process only; the bytes are served by the public photo route.
   */
  publishedProductImages(
    context: CallContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<
    Result<
      ReadonlyMap<Id<'Product'>, readonly PublishedImageRef[]>,
      AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge
    >
  >;

  /**
   * Which of the requested product revisions, each named with its product, still waits for
   * review (it is its product's pending revision now), at most 200, refused whole above. Rule `system`: for the admins' review
   * notice (in-app notifications package 3). An unknown id, another Market's, a published or a
   * replaced revision is absent. Ids only. In-process only.
   */
  pendingProductRevisions(
    context: CallContext,
    revisions: readonly {
      readonly productId: Id<'Product'>;
      readonly revisionId: Id<'ProductRevision'>;
    }[],
  ): Promise<
    Result<
      ReadonlySet<Id<'ProductRevision'>>,
      AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge
    >
  >;

  /**
   * The owning seller of each requested SELLER product, at most 200, refused whole above. Rule
   * `system`: for the sellers' product notices (in-app notifications package 4). A PLATFORM
   * product, an unknown id and another Market's are absent. Ids only. In-process only.
   */
  sellerProductOwners(
    context: CallContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<
    Result<
      ReadonlyMap<Id<'Product'>, Id<'Seller'>>,
      AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge
    >
  >;
}

/** Nest token of the {@link CatalogFacade}, provided and exported by `CatalogModule`. */
export const CATALOG_FACADE = Symbol('CATALOG_FACADE');
