import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { SellerSummary } from '../domain/seller-summary';

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
   * (slice 1; the time zone, the slug and the public store name join in later slices). An unknown
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
}

/** Nest token of the {@link SellersFacade}, provided and exported by `SellersModule`. */
export const SELLERS_FACADE = Symbol('SELLERS_FACADE');
