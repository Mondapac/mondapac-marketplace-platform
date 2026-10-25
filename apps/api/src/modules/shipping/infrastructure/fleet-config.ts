import type { Money } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { FleetCapabilities, FleetCode } from '../domain/fleet';

/** One entry of `shipping.fleets` as the Market config loader parses it. */
export type FleetEntry = NonNullable<NonNullable<MarketConfig['shipping']>['fleets']>[FleetCode] &
  object;

/**
 * A fleet's capabilities from its `shipping.fleets` entry. `idempotentBooking` and
 * `supportsWindow` are facts of the adapter, not settings, so the adapter passes them in.
 * `currency` is the Market's, for the order value limit.
 */
export function capabilitiesOf(
  fleet: FleetCode,
  entry: FleetEntry,
  currency: string,
  adapter: { readonly idempotentBooking: boolean; readonly supportsWindow: boolean },
): FleetCapabilities | null {
  if (!entry.enabled) return null;
  const maxOrderValue: Money | null =
    entry.maxOrderValueMinor === null
      ? null
      : { amount: BigInt(entry.maxOrderValueMinor), currency };
  return {
    fleet,
    methods: entry.methods,
    serviceAreas: entry.serviceAreas,
    outsideCityAreasOnly: entry.outsideCityAreasOnly,
    temperatures: entry.temperatures,
    maxItemWeightGrams: entry.maxItemWeightGrams,
    maxItems: entry.maxItems,
    maxOrderValue,
    prohibitedClasses: entry.prohibitedClasses,
    idempotentBooking: adapter.idempotentBooking,
    supportsWindow: adapter.supportsWindow,
  };
}
