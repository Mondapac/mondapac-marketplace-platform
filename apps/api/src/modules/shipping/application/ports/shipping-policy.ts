import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market settings shipping reads. */
export interface ShippingPolicy {
  /** The currency of every delivery price of the Market. */
  currency(market: MarketContext): string;

  /** The Market's IANA zone: only the fallback for a seller without a zone (ADR-0005). */
  timeZone(market: MarketContext): string;

  /**
   * Whether the Market delivers to the postcode: true only when the postcode falls in a
   * ServiceArea whose `deliveryEnabled` is on (config/service-areas). No area, or an area not
   * open for delivery, is false (fail closed).
   */
  deliversTo(market: MarketContext, postcode: string): boolean;

  /**
   * The most the platform absorbs, in minor units, when a booking goes to a dearer fleet than the
   * one the buyer was charged for (the Market's `shipping.fleetFallbackAbsorbCapMinor`; 0 when the
   * Market sets none, so every difference alerts).
   */
  fleetFallbackCapMinor(market: MarketContext): number;

  /**
   * The range, in minor units, a fleet's quote must fall in to be shown and charged (the Market's
   * `shipping.realTimeCarrier.quoteBounds`), or null when the Market sets none.
   */
  quoteBounds(
    market: MarketContext,
  ): { readonly minMinor: number; readonly maxMinor: number } | null;
}

export const SHIPPING_POLICY = Symbol('SHIPPING_POLICY');
