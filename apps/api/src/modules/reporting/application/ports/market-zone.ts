import type { MarketContext } from '@mondapac/shared-kernel';

/** The IANA zone a Market counts its days in (Market configuration, ADR-0005). */
export interface MarketZone {
  zoneOf(market: MarketContext): string;
}

export const MARKET_ZONE = Symbol('reporting.MarketZone');
