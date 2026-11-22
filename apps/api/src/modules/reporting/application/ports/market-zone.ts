import type { MarketContext } from '@mondapac/shared-kernel';

/** What reporting reads of the Market's configuration (ADR-0005, ADR-0007). */
export interface MarketZone {
  /** The IANA zone the Market counts its days in. */
  zoneOf(market: MarketContext): string;
  /** The ISO 4217 currency of the Market's prices: every fact is in it. */
  currencyOf(market: MarketContext): string;
}

export const MARKET_ZONE = Symbol('reporting.MarketZone');
