import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { SellerSummary } from '../domain/seller-summary';

/** One answer per distinct requested seller (sellers design 7.2). */
export type SellingEligibilityMap = ReadonlyMap<Id<'Seller'>, { readonly eligible: boolean }>;

/** Every product type, or the listed type codes (SEL-12). */
export type AllowedProductTypesOf = 'all' | ReadonlySet<string>;

/** A request the facade refused before any read: a code and the fields, never their values. */
export interface SellersValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/**
 * What `reviewerBusinessDetails` returns (sellers design 7.1): the approved revision's legal name,
 * trading name and addresses, in clear. Personal data: the caller shows it to the reviewer and
 * never logs, stores or forwards it.
 */
export interface ReviewerBusinessDetails {
  readonly sellerId: Id<'Seller'>;
  readonly revisionId: Id<'BusinessFileRevision'>;
  /** The business (legal) name. */
  readonly businessName: string;
  /** The store (trading) name. */
  readonly storeName: string;
  /** The address where the shop operates. */
  readonly operatingAddress: Readonly<Record<string, string>>;
  /** The registered address when the seller captured one that differs, else null. */
  readonly registeredAddress: Readonly<Record<string, string>> | null;
}

/**
 * What `carrierPickup` returns: where the real-time carrier collects a seller's parcel, from the
 * approved revision. PERSONAL DATA: shipping hands it to the carrier and never logs, stores or
 * forwards it anywhere else.
 */
export interface CarrierPickup {
  readonly sellerId: Id<'Seller'>;
  readonly storeName: string;
  readonly phone: string;
  /** The operating address: the fields of the Market's `address.format`. */
  readonly operatingAddress: Readonly<Record<string, string>>;
}

/** The seller is unknown here, or has no approved revision yet. Both answer alike. */
export interface SellerDetailsNotFound {
  readonly code: 'seller.details-not-found';
}

/** The read failed. There is no partial answer and nothing is cached; callers fail closed. */
export interface SellersUnavailable {
  readonly code: 'sellers.unavailable';
}

/**
 * The public facade of `sellers` (sellers design 7.1). Every method takes the caller's
 * `CallContext` first, unchanged, and is a thin call of one use case, so the gate runs (PF 6.4
 * row 2). Other modules inject {@link SELLERS_FACADE}; they never read sellers' tables.
 */
export interface SellersFacade {
  /**
   * Per distinct requested id, in the order of first occurrence: whether the seller has a file
   * (slice 1) and, for the `system` caller only, the draft's operating zone with `provisional:
   * true` (slice 2; Hassan L4; absent when none is set; the slug and the public store name join
   * in later slices). A request actor never gets the zone. An unknown
   * id and an id of another Market are byte-identical. At most 100 ids; a larger or malformed
   * call is refused whole. Two use cases behind this method: `anonymous` for a request actor,
   * `system` for the system actor. Not exposed over HTTP.
   */
  sellerSummaries(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<readonly SellerSummary[], AccessDenied | SellersValidationFailed | SellersUnavailable>
  >;

  /**
   * The may-sell contract (sellers design 7.2): per distinct requested id, `eligible`. Yes only
   * when `identity` says `approved`, the seller has an approved revision in the context's Market,
   * that revision has an identifier when the Market's current rule requires one, its operating
   * zone is a known IANA zone, and no `identifier-claim-conflict` admin flag is open. Fails
   * closed: an unknown id, a missing record or any error is `eligible: false`, never cached, and
   * no reason leaves the facade. Callers treat any `ok: false` (`AccessDenied`,
   * `validation.failed`) and any missing key as not eligible; nothing is retried towards a yes.
   * For the system actor only, a failed read is `sellers.unavailable` rather than all "no", so an
   * event handler or job can retry (a request caller still gets "no").
   * At most 100 ids; a larger or malformed call is refused whole. Two use cases behind this
   * method, as for `sellerSummaries`. Not exposed over HTTP.
   */
  sellingEligibility(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<SellingEligibilityMap, AccessDenied | SellersValidationFailed | SellersUnavailable>
  >;

  /**
   * `allowedProductTypesOf` (sellers design 7.1; SEL-12): `all`, or the set of type codes the
   * seller may sell. Until slice 14 the answer is `all` for every seller whose setting is on (all
   * of them; ADR-0031 decision 4a) and the empty set otherwise. An unknown seller, another
   * Market's seller or a read error is `sellers.unavailable`: the caller refuses and never reads
   * an error as allowed. Two use cases behind this method, as for `sellerSummaries`. Not exposed
   * over HTTP.
   */
  allowedProductTypesOf(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<
    Result<AllowedProductTypesOf, AccessDenied | SellersValidationFailed | SellersUnavailable>
  >;

  /**
   * `publishedStoreSellerId` (storefront products package): the seller that holds `slug` as a
   * store address, or `null`. Yes only under the published-store rules of the public store page
   * (an approved revision, a `held` slug, and the may-sell contract says yes); an unknown,
   * malformed, retired or not-selling slug is `null`, byte-identical. A request actor only (rule
   * `anonymous`); ids only, never a store field. A fault is `sellers.unavailable`: the caller
   * fails closed. In-process only.
   */
  publishedStoreSellerId(
    context: CallContext,
    slug: string,
  ): Promise<Result<Id<'Seller'> | null, AccessDenied | SellersUnavailable>>;

  /**
   * `publishedStoreSlugs` (storefront slider): the held store address of each requested seller
   * (at most 100 ids), only under the published-store rules of the public store page (approved
   * revision, `held` slug, the may-sell contract says yes). A seller that is unknown, of another
   * Market, not approved or not selling is absent from the map, byte-identical. A request actor
   * only (rule `anonymous`); ids and slugs only. A fault is `sellers.unavailable`: the caller
   * fails closed. In-process only.
   */
  publishedStoreSlugs(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, AccessDenied | SellersUnavailable>>;

  /**
   * `reviewerBusinessDetails` (sellers design 7.1; board 13 item 3): legal name, trading name and
   * the operating and registered addresses of the seller's **approved** revision, for a
   * certification reviewer. Rule `permissions [sellers.business-details.view]` (Hassan M4): a
   * caller without the key gets `access.denied`. Personal data: one `sellers.business-details.viewed`
   * audit row is written per read in the same unit, and a refused row means nothing is returned.
   * An unknown id, another Market's seller and a seller with no approved revision are
   * `seller.details-not-found`, byte-identical. Not exposed over HTTP.
   */
  reviewerBusinessDetails(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<
    Result<
      ReviewerBusinessDetails,
      AccessDenied | SellersValidationFailed | SellerDetailsNotFound | SellersUnavailable
    >
  >;

  /**
   * `carrierPickup` (SHP-02/03): the store name, phone and operating address of the seller's
   * **approved** revision, for shipping to hand to the real-time carrier as the pickup of one
   * paid seller order. Rule `system`. Personal data: one
   * `sellers.pickup-details.read-for-carrier` audit row (with the seller order id) is written per
   * read, and a refused row means nothing is returned. An unknown id, another Market's seller and
   * a seller with no approved revision are `seller.details-not-found`. Not exposed over HTTP.
   */
  carrierPickup(
    context: CallContext,
    request: { readonly sellerId: Id<'Seller'>; readonly sellerOrderId: string },
  ): Promise<
    Result<
      CarrierPickup,
      AccessDenied | SellersValidationFailed | SellerDetailsNotFound | SellersUnavailable
    >
  >;

  /**
   * `pickupPostcodes` (SHP-02/03): the postcode of each seller's **approved** operating address,
   * for shipping to quote the real-time carrier at checkout. A clear column copied at submission
   * (like the ServiceArea code): no decryption and no audit row. Rule `anonymous`. A seller with
   * no approved revision, of another Market, or whose revision predates the column is absent from
   * the map. At most 100 ids. Not exposed over HTTP.
   */
  pickupPostcodes(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<
      ReadonlyMap<Id<'Seller'>, string>,
      AccessDenied | SellersValidationFailed | SellersUnavailable
    >
  >;
}

/** Nest token of the {@link SellersFacade}, provided and exported by `SellersModule`. */
export const SELLERS_FACADE = Symbol('SELLERS_FACADE');
