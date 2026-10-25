// The `real_time_delivery` FulfillmentStrategy (technical spec, extension points): a seller order
// goes to a real-time carrier when the Market has the carrier on and both ends of the trip are in
// a ServiceArea the carrier serves. The seller never delivers (owner decision, delivery models):
// when no carrier can serve, the order has no strategy and the platform must look at it. Pure: the
// caller resolves each postcode to its ServiceArea code (or null) from configuration first.

/** The FulfillmentStrategy code of a seller order handed to a real-time carrier. */
export const REAL_TIME_DELIVERY = 'real_time_delivery';

/**
 * No carrier can serve the trip: the platform must arrange the delivery (a "needs platform
 * attention" state). There is no seller-delivered fallback.
 */
export const NO_CARRIER = 'no_carrier';

export type FulfillmentStrategyCode = typeof REAL_TIME_DELIVERY | typeof NO_CARRIER;

export interface RealTimeCarrierCoverage {
  /** The ServiceArea codes the carrier serves in this Market; empty means none. */
  readonly serviceAreas: readonly string[];
}

/**
 * Which strategy fulfils a seller order: `real_time_delivery` only when the carrier is configured
 * for the Market (`coverage` is not null) and the pickup and the drop-off each fall in one of its
 * areas. Anything unknown is `no_carrier` (fail safe: never a booking the carrier cannot
 * serve, and never a delivery by the seller).
 */
export function fulfilmentStrategyFor(
  coverage: RealTimeCarrierCoverage | null,
  pickupArea: string | null,
  dropoffArea: string | null,
): FulfillmentStrategyCode {
  if (coverage === null || pickupArea === null || dropoffArea === null) return NO_CARRIER;
  const served = new Set(coverage.serviceAreas);
  return served.has(pickupArea) && served.has(dropoffArea) ? REAL_TIME_DELIVERY : NO_CARRIER;
}
