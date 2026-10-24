// The `real_time_delivery` FulfillmentStrategy (technical spec, extension points): a seller order
// goes to a real-time carrier instead of the seller's own shipment when the Market has the
// carrier on and both ends of the trip are in a ServiceArea the carrier serves. Pure: the caller
// resolves each postcode to its ServiceArea code (or null) from configuration first.

/** The FulfillmentStrategy code of a seller order handed to a real-time carrier. */
export const REAL_TIME_DELIVERY = 'real_time_delivery';

/** The `seller_managed` strategy: the seller ships and types in the carrier (SHP-01). */
export const SELLER_MANAGED = 'seller_managed';

export type FulfillmentStrategyCode = typeof REAL_TIME_DELIVERY | typeof SELLER_MANAGED;

export interface RealTimeCarrierCoverage {
  /** The ServiceArea codes the carrier serves in this Market; empty means none. */
  readonly serviceAreas: readonly string[];
}

/**
 * Which strategy fulfils a seller order: `real_time_delivery` only when the carrier is configured
 * for the Market (`coverage` is not null) and the pickup and the drop-off each fall in one of its
 * areas. Anything unknown is `seller_managed`: the seller ships as today (fail safe, never a
 * booking the carrier cannot serve).
 */
export function fulfilmentStrategyFor(
  coverage: RealTimeCarrierCoverage | null,
  pickupArea: string | null,
  dropoffArea: string | null,
): FulfillmentStrategyCode {
  if (coverage === null || pickupArea === null || dropoffArea === null) return SELLER_MANAGED;
  const served = new Set(coverage.serviceAreas);
  return served.has(pickupArea) && served.has(dropoffArea) ? REAL_TIME_DELIVERY : SELLER_MANAGED;
}
