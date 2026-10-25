import type { MarketContext, MarketId, Money } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';

export type UberDirectConfig = NonNullable<NonNullable<MarketConfig['shipping']>['uberDirect']>;

/** The Uber Direct credentials of the Region Stack, as `MARKET=value` maps (see `AppConfig`). */
export interface UberDirectCredentials {
  readonly customerIds: Readonly<Record<string, string>>;
  readonly clientIds: Readonly<Record<string, string>>;
  readonly clientSecrets: Readonly<Record<string, string>>;
}

/** What one Market's Uber Direct is, ready for a call: settings, credentials and the country. */
export interface UberDirectMarketSettings {
  readonly config: UberDirectConfig;
  readonly country: string;
  readonly customerId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * What a fleet router needs to know before it offers Uber Direct a trip: plain data, no secrets.
 * The order value cap is in the Market's default currency.
 */
export interface UberDirectCapabilities {
  readonly fleet: 'uber-direct';
  readonly modes: readonly ('on_demand' | 'scheduled')[];
  readonly serviceAreas: readonly string[];
  readonly maxItemWeightGrams: number;
  readonly maxItems: number;
  readonly maxOrderValue: Money;
  readonly prohibitedClasses: readonly string[];
}

/**
 * Uber Direct's settings of a Market from `shipping.uberDirect`, on only when the section says
 * `enabled`, the Market has an address country and the Region Stack holds all three credentials
 * (fail closed: absent means off).
 */
export class ConfigUberDirectPolicy {
  constructor(
    private readonly markets: MarketRegistry,
    private readonly credentials: UberDirectCredentials,
  ) {}

  /** The settings for a call, or null when Uber Direct is off for the Market. */
  settings(marketId: MarketId): UberDirectMarketSettings | null {
    const market = this.markets.get(marketId);
    const config = market.shipping?.uberDirect;
    const country = market.customers?.address.countryCode;
    const pick = (values: Readonly<Record<string, string>>): string | undefined =>
      Object.hasOwn(values, marketId) ? values[marketId] : undefined;
    const customerId = pick(this.credentials.customerIds);
    const clientId = pick(this.credentials.clientIds);
    const clientSecret = pick(this.credentials.clientSecrets);
    if (
      config === undefined ||
      !config.enabled ||
      country === undefined ||
      customerId === undefined ||
      clientId === undefined ||
      clientSecret === undefined
    ) {
      return null;
    }
    return { config, country, customerId, clientId, clientSecret };
  }

  /** The fleet's capabilities in the Market, or null when it is off. */
  capabilities(market: MarketContext): UberDirectCapabilities | null {
    const settings = this.settings(market.marketId);
    if (settings === null) return null;
    const { config } = settings;
    return {
      fleet: 'uber-direct',
      modes: [...config.modes],
      serviceAreas: [...config.serviceAreas],
      maxItemWeightGrams: config.limits.maxItemWeightGrams,
      maxItems: config.limits.maxItems,
      // The currency is the Market's, never a constant of the core.
      maxOrderValue: {
        amount: BigInt(config.limits.maxOrderValueMinor),
        currency: this.markets.get(market.marketId).defaultCurrency,
      },
      prohibitedClasses: [...config.prohibitedClasses],
    };
  }
}
