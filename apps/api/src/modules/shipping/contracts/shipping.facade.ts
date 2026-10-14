import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

export type ShippingFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  /** The read failed: callers fail closed and never read this as "no fee". */
  | { readonly code: 'shipping.unavailable' };

/** The flat fee of each requested seller that has one; a seller without a fee is absent. */
export type FlatFeeMap = ReadonlyMap<Id<'Seller'>, Money>;

/**
 * What `ordering` calls at checkout. The method takes the caller's `CallContext` unchanged and
 * is not exposed over HTTP.
 */
export interface ShippingFacade {
  /**
   * The flat shipping fee per seller (one fee per seller order, an explicit zero is a fee). At
   * most 100 distinct ids. A seller with no fee set is missing from the map; ordering then
   * refuses that seller's lines (fail closed).
   */
  flatFees(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<FlatFeeMap, ShippingFailure>>;
}

/** Nest token of the {@link ShippingFacade}, provided and exported by `ShippingModule`. */
export const SHIPPING_FACADE = Symbol('SHIPPING_FACADE');
