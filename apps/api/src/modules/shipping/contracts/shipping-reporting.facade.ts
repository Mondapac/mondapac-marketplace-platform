import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** The most quotes, and the most pickup sellers, one {@link ShippingReportingFacade} call takes. */
export const MAX_REPORT_REGIONS = 100;

export type ShippingReportingFailure =
  AccessDenied | { readonly code: 'validation.failed' } | { readonly code: 'shipping.unavailable' };

/** The region (state) codes shipping derives for reporting; an absent key is unknown. */
export interface DeliveryRegions {
  /** The region of each charged quote's drop-off postcode, by quote id. */
  readonly quotes: ReadonlyMap<string, string>;
  /** The region of each seller's pickup (its approved operating address), by seller id. */
  readonly pickups: ReadonlyMap<Id<'Seller'>, string>;
}

/**
 * What `reporting` may read of shipping (dashboards v2, phase 1). Rule `system`: only reporting's
 * worker, nightly reconcile and backfill call it, as the Market's system actor. Not exposed over
 * HTTP. It answers region codes only (1 to 3 capital letters or digits, from the Market's
 * `shipping.postcodeRegions`): never a postcode, an address, a name or an account.
 */
export interface ShippingReportingFacade {
  /**
   * The region of the drop-off of each quote, and of the pickup of each seller (at most
   * {@link MAX_REPORT_REGIONS} of each). An unknown quote (or one already removed), another
   * Market's, a seller without an approved pickup postcode and a postcode in no configured range
   * are absent.
   */
  deliveryRegions(
    context: CallContext,
    request: {
      readonly quoteIds: readonly string[];
      readonly pickupSellerIds: readonly Id<'Seller'>[];
    },
  ): Promise<Result<DeliveryRegions, ShippingReportingFailure>>;
}

/** Nest token of the {@link ShippingReportingFacade}, provided and exported by `ShippingModule`. */
export const SHIPPING_REPORTING_FACADE = Symbol('SHIPPING_REPORTING_FACADE');
