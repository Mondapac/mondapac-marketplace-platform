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
}

/** Nest token of the {@link CatalogFacade}, provided and exported by `CatalogModule`. */
export const CATALOG_FACADE = Symbol('CATALOG_FACADE');
