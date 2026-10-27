import type { MarketContext } from '@mondapac/shared-kernel';
import type { FleetCode, Temperature } from '../../domain/fleet';

/** The size and temperature of a parcel until offers carry their own. */
export interface ParcelDefaults {
  readonly weightGrams: number;
  readonly volumeLitres: number;
  readonly temperature: Temperature;
}

/** A Market's settings of its real-time carrier (Mondapac Drive; the legacy single-carrier section) (`shipping.realTimeCarrier`). */
export interface RealTimeCarrierSettings {
  /** The carrier name the customer and the seller see ("Mondapac Drive"). */
  readonly displayName: string;
  /** The ServiceArea codes the carrier serves. */
  readonly serviceAreas: readonly string[];
  readonly parcel: ParcelDefaults;
  readonly mode: 'on_demand' | 'scheduled';
  /** The range, in minor units of the Market's currency, a live quote must fall in to be charged. */
  readonly quoteBounds: { readonly minMinor: number; readonly maxMinor: number };
}

/** The Market settings the carrier flows read. */
export interface CarrierPolicy {
  /**
   * The real-time carrier of the Market, or null: no settings, or the carrier has no API key or
   * no webhook secret in this Region Stack (fail closed: nothing is booked).
   */
  realTimeCarrier(market: MarketContext): RealTimeCarrierSettings | null;

  /** The parcel every booking assumes until offers carry their own sizes. */
  parcelDefaults(market: MarketContext): ParcelDefaults;

  /** The name of a fleet the customer and the seller see ("Mondapac Drive"). */
  fleetDisplayName(market: MarketContext, fleet: FleetCode): string;

  /** The code of the ServiceArea a postcode falls in, whatever its flags; null when none. */
  serviceAreaOf(market: MarketContext, postcode: string): string | null;
}

export const CARRIER_POLICY = Symbol('CARRIER_POLICY');
