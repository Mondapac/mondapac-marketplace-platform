import type { MarketContext, MarketId, Money } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';

export type Zoom2uConfig = NonNullable<NonNullable<MarketConfig['shipping']>['zoom2u']>;

/** The Zoom2u API keys of the Region Stack, as a `MARKET=key` map (see `AppConfig`). */
export interface Zoom2uCredentials {
  readonly apiKeys: Readonly<Record<string, string>>;
}

/** What one Market's Zoom2u is, ready for a call: settings, key, country and currency. */
export interface Zoom2uMarketSettings {
  readonly config: Zoom2uConfig;
  readonly country: string;
  /** The Market's default currency: Zoom2u prices carry none. */
  readonly currency: string;
  readonly apiKey: string;
}

/**
 * What a fleet router needs to know before it offers Zoom2u a trip: plain data, no secrets (the
 * same shape as Uber Direct's). The order value cap is in the Market's default currency.
 */
export interface Zoom2uCapabilities {
  readonly fleet: 'zoom2u';
  readonly modes: readonly ('on_demand' | 'scheduled')[];
  readonly serviceAreas: readonly string[];
  readonly maxItemWeightGrams: number;
  readonly maxItems: number;
  readonly maxOrderValue: Money;
  readonly prohibitedClasses: readonly string[];
}

/**
 * Zoom2u's settings of a Market from `shipping.zoom2u`, on only when the section says `enabled`,
 * the Market has an address country and the Region Stack holds the API key (fail closed: absent
 * means off).
 */
export class ConfigZoom2uPolicy {
  constructor(
    private readonly markets: MarketRegistry,
    private readonly credentials: Zoom2uCredentials,
  ) {}

  /** The settings for a call, or null when Zoom2u is off for the Market. */
  settings(marketId: MarketId): Zoom2uMarketSettings | null {
    const market = this.markets.get(marketId);
    const config = market.shipping?.zoom2u;
    const country = market.customers?.address.countryCode;
    const apiKey = Object.hasOwn(this.credentials.apiKeys, marketId)
      ? this.credentials.apiKeys[marketId]
      : undefined;
    if (config === undefined || !config.enabled || country === undefined || apiKey === undefined) {
      return null;
    }
    return { config, country, currency: market.defaultCurrency, apiKey };
  }

  /** The fleet's capabilities in the Market, or null when it is off. */
  capabilities(market: MarketContext): Zoom2uCapabilities | null {
    const settings = this.settings(market.marketId);
    if (settings === null) return null;
    const { config } = settings;
    return {
      fleet: 'zoom2u',
      modes: [...config.modes],
      serviceAreas: [...config.serviceAreas],
      maxItemWeightGrams: config.limits.maxItemWeightGrams,
      maxItems: config.limits.maxItems,
      // The currency is the Market's, never a constant of the core.
      maxOrderValue: {
        amount: BigInt(config.limits.maxOrderValueMinor),
        currency: settings.currency,
      },
      prohibitedClasses: [...config.prohibitedClasses],
    };
  }
}
