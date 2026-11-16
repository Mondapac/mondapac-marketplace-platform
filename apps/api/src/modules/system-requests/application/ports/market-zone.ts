import type { MarketContext } from '@mondapac/shared-kernel';

/** The IANA zone of the Market (its fallback zone, ADR-0005): the day a reminder belongs to. */
export interface MarketZone {
  zoneOf(market: MarketContext): string;
}

export const MARKET_ZONE = Symbol('SYSTEM_REQUESTS_MARKET_ZONE');
