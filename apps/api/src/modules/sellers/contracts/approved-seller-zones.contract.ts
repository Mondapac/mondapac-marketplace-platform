import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ApprovedSellerZone } from '../domain/seller-summary';
import type { SellersUnavailable, SellersValidationFailed } from './sellers.facade';

// The approved-seller-zones contract of `sellers` (sellers design 7.1a; request S-1 of
// `certification`; Hassan L4). It is a contract of its own and not a method of `SellersFacade`
// so that dependency-cruiser can confine it: `approved-seller-zones-contract-is-for-certification`
// lets only `modules/sellers/`, certification's application and infrastructure layers and its
// Nest module import this file (ADR-0033, pending: restricted contract files, amends ADR-0008).
// `contracts/index.ts` does not export it (only the map type is re-exported). Certification
// reaches it through a certification-owned port with an infrastructure adapter that imports the
// token. Its two use cases, `anonymous` and `system`, are for that one caller; no controller may
// reach them (test/authz/anonymous-system-pairs-not-over-http.spec.ts).

/** One entry per distinct requested id (sellers design 7.1a row 1). */
export type ApprovedSellerZonesMap = ReadonlyMap<Id<'Seller'>, ApprovedSellerZone>;

/**
 * The fixed zone read for `certification`'s `evaluateClaims` only: per distinct requested id, in
 * first-occurrence order, `{ zone, addressZone }` of the approved revision, each an IANA id or
 * null; a missing zone is the consumer's `seller-zone-missing`. The answer is the same for every
 * caller (it reads the Market and the ids only). A seller with no approved
 * revision (and an id of another Market or never issued, alike) answers `{ zone: null,
 * addressZone: null }`; the zones come from the clear columns of the approved revision (slice 5b).
 * A read that fails is `sellers.unavailable`, never nulls. Exactly one
 * key per distinct id; an empty list answers an empty map; more than 100 entries (before or
 * after collapsing duplicates) or a malformed id is refused whole. A consumer treats any `ok:
 * false` as a failed batch and an unexpected key as a fault. Two use cases behind this method
 * (`anonymous` for a request actor, `system` for the system actor). Not exposed over HTTP.
 */
export interface ApprovedSellerZonesReader {
  approvedSellerZones(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<ApprovedSellerZonesMap, AccessDenied | SellersValidationFailed | SellersUnavailable>
  >;
}

/**
 * Nest token of the {@link ApprovedSellerZonesReader}, provided and exported by `SellersModule`.
 * Only certification's infrastructure adapter (and its Nest module) may import it.
 */
export const APPROVED_SELLER_ZONES = Symbol('APPROVED_SELLER_ZONES');
