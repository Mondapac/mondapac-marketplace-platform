import type { MarketContext } from '@mondapac/shared-kernel';
import type { CarrierParcel } from './carrier-gateway';

/** A Market's settings of its real-time carrier (`shipping.realTimeCarrier`). */
export interface RealTimeCarrierSettings {
  /** The carrier name the customer and the seller see ("Mondapac Drive"). */
  readonly displayName: string;
  /** The ServiceArea codes the carrier serves. */
  readonly serviceAreas: readonly string[];
  readonly parcel: CarrierParcel;
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

  /** The code of the ServiceArea a postcode falls in, whatever its flags; null when none. */
  serviceAreaOf(market: MarketContext, postcode: string): string | null;
}

export const CARRIER_POLICY = Symbol('CARRIER_POLICY');
