import type { CarrierGateway, FleetCode } from './carrier-gateway';

/**
 * The fleets the platform can book, keyed by {@link FleetCode}: one gateway per fleet. A fleet is
 * a candidate for a Market only when its gateway's `capabilities(market)` is not null.
 */
export interface FleetRegistry {
  get(fleet: FleetCode): CarrierGateway | undefined;
  /** Every registered gateway, in no promised order. */
  all(): readonly CarrierGateway[];
}

export const FLEET_REGISTRY = Symbol('FLEET_REGISTRY');
