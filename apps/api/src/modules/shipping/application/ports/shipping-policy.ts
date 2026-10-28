import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market settings shipping reads. */
export interface ShippingPolicy {
  /** The currency every flat fee of the Market is in. */
  currency(market: MarketContext): string;

  /** The Market's IANA zone: only the fallback for a seller without a zone (ADR-0005). */
  timeZone(market: MarketContext): string;

  /**
   * Whether the Market delivers to the postcode: true only when the postcode falls in a
   * ServiceArea whose `deliveryEnabled` is on (config/service-areas). No area, or an area not
   * open for delivery, is false (fail closed).
   */
  deliversTo(market: MarketContext, postcode: string): boolean;
}

export const SHIPPING_POLICY = Symbol('SHIPPING_POLICY');
