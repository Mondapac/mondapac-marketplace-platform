import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ApprovedSellerZone, SellerSummary } from '../domain/seller-summary';

/** One answer per distinct requested seller (sellers design 7.2). */
export type SellingEligibilityMap = ReadonlyMap<Id<'Seller'>, { readonly eligible: boolean }>;

/** One entry per distinct requested id (sellers design 7.1a row 1). */
export type ApprovedSellerZonesMap = ReadonlyMap<Id<'Seller'>, ApprovedSellerZone>;

/** A request the facade refused before any read: a code and the fields, never their values. */
export interface SellersValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
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
   * The may-sell contract (sellers design 7.2): per distinct requested id, `eligible`. Fails
   * closed: an unknown id, a missing record or any error is `eligible: false`, never cached, and
   * no reason leaves the facade. **Until slice 9 every answer is `false`**, because the contract
   * needs an approved `sellers` revision (7.2 row 2) and none exists before slice 7a-decide;
   * identity's `approved` alone never means eligible (ADR-0022 decision 6). Callers treat any
   * `ok: false` (`AccessDenied`, `validation.failed`) and any missing key as not eligible; nothing
   * is cached and nothing is retried towards a yes. At most 100 ids; a larger or malformed call is refused
   * whole. Two use cases behind this method, as for `sellerSummaries`. Not exposed over HTTP.
   */
  sellingEligibility(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<SellingEligibilityMap, AccessDenied | SellersValidationFailed>>;

  /**
   * The fixed zone read for `certification`'s `evaluateClaims` only (sellers design 7.1a; request
   * S-1): per distinct requested id, in first-occurrence order, `{ zone, addressZone }` of the
   * approved revision, each an IANA id or null; a missing zone is the consumer's
   * `seller-zone-missing`. The answer is the same for every caller (it reads the Market and the
   * ids only). **Until slice 5 every entry is `{ zone: null, addressZone: null }`**, because no
   * approved revision exists and nothing is read. Exactly one key per distinct id; an empty list
   * answers an empty map; more than 100 entries (before or after collapsing duplicates) or a
   * malformed id is refused whole. A consumer treats any `ok: false` as a failed batch and an
   * unexpected key as a fault. Two use cases behind this method, as for `sellerSummaries`. Not
   * exposed over HTTP.
   */
  approvedSellerZones(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<ApprovedSellerZonesMap, AccessDenied | SellersValidationFailed>>;
}

/** Nest token of the {@link SellersFacade}, provided and exported by `SellersModule`. */
export const SELLERS_FACADE = Symbol('SELLERS_FACADE');
