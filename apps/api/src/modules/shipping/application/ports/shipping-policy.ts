import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market settings shipping reads. */
export interface ShippingPolicy {
  /** The currency every flat fee of the Market is in. */
  currency(market: MarketContext): string;
}

export const SHIPPING_POLICY = Symbol('SHIPPING_POLICY');
