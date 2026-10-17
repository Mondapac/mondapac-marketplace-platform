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
}

/** Nest token of the {@link CatalogFacade}, provided and exported by `CatalogModule`. */
export const CATALOG_FACADE = Symbol('CATALOG_FACADE');
