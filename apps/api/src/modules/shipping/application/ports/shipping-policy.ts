import type { MarketContext } from '@mondapac/shared-kernel';

/** A GeoJSON MultiPolygon in WGS 84 degrees: polygons of rings of [longitude, latitude]. */
export interface AreaOutline {
  readonly type: 'MultiPolygon';
  readonly coordinates: readonly (readonly (readonly (readonly [number, number])[])[])[];
}

/** The outlines of the areas open for delivery and their credit (public configuration). */
export interface DeliveryAreaOutlines {
  readonly areas: readonly {
    readonly code: string;
    readonly names: Readonly<Record<string, string>>;
    readonly boundary: AreaOutline;
  }[];
  readonly source: {
    readonly name: string;
    readonly licence: string;
    readonly attribution: string;
  } | null;
}

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
   * The outlines of the ServiceAreas open for delivery (config/service-area-boundaries), for the
   * storefront map. An area closed for delivery or without an outline is left out.
   */
  deliveryAreaOutlines(market: MarketContext): DeliveryAreaOutlines;

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

  /**
   * The region (state) code of the postcode, from the Market's `shipping.postcodeRegions`
   * (dashboards v2): 1 to 3 capital letters or digits, or null when no range holds it or the
   * Market has no table. Only this code leaves shipping, never the postcode.
   */
  regionOfPostcode(market: MarketContext, postcode: string): string | null;
}

export const SHIPPING_POLICY = Symbol('SHIPPING_POLICY');
