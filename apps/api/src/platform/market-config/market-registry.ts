import type { MarketConfig } from './market-config';

export class MarketNotHostedError extends Error {
  constructor(readonly marketId: string) {
    super(`Market "${marketId}" is not hosted by this Region Stack`);
    this.name = 'MarketNotHostedError';
  }
}

/**
 * The Markets this Region Stack serves (ADR-0003). There is no default market: callers
 * always name the market, and a market outside HOSTED_MARKETS is rejected.
 */
export class MarketRegistry {
  constructor(private readonly markets: ReadonlyMap<string, MarketConfig>) {}

  /** Codes of all hosted markets, in HOSTED_MARKETS order. */
  hostedMarketIds(): readonly string[] {
    return [...this.markets.keys()];
  }

  isHosted(marketId: string): boolean {
    return this.markets.has(marketId);
  }

  /** @throws MarketNotHostedError when the market is not hosted here (residency guard). */
  get(marketId: string): MarketConfig {
    const market = this.markets.get(marketId);
    if (market === undefined) throw new MarketNotHostedError(marketId);
    return market;
  }
}
