import type { MarketContext, MarketId, Money } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';

export type AusPostConfig = NonNullable<NonNullable<MarketConfig['shipping']>['auspost']>;

/**
 * The Australia Post credentials of the Region Stack, as `MARKET=value` maps (see `AppConfig`).
 * All three secrets: never logged, never put in an error.
 */
export interface AusPostCredentials {
  readonly apiKeys: Readonly<Record<string, string>>;
  readonly apiPasswords: Readonly<Record<string, string>>;
  readonly accountNumbers: Readonly<Record<string, string>>;
}

/** What one Market's Australia Post is, ready for a call: settings, credentials and currency. */
export interface AusPostMarketSettings {
  readonly config: AusPostConfig;
  /** The Market's default currency: Australia Post prices carry none in the answers we read. */
  readonly currency: string;
  readonly apiKey: string;
  readonly apiPassword: string;
  readonly accountNumber: string;
}

/**
 * What a fleet router needs to know before it offers Australia Post a trip: plain data, no
 * secrets (the same shape as Uber Direct's and Zoom2u's, plus `outsideCityAreasOnly`). When
 * `outsideCityAreasOnly` is true, `serviceAreas` lists the city areas the fleet does NOT serve
 * (the city fleets do) and every address outside them is in its area: a wildcard modelled as
 * configuration, never as a country check in core logic. The order value cap is in the Market's
 * default currency.
 */
export interface AusPostCapabilities {
  readonly fleet: 'auspost';
  readonly modes: readonly ('on_demand' | 'scheduled')[];
  readonly outsideCityAreasOnly: boolean;
  readonly serviceAreas: readonly string[];
  readonly maxItemWeightGrams: number;
  readonly maxItems: number;
  readonly maxOrderValue: Money;
  readonly prohibitedClasses: readonly string[];
}

/**
 * Australia Post's settings of a Market from `shipping.auspost`, on only when the section says
 * `enabled` and the Region Stack holds the API key, the password AND the account number (fail
 * closed: absent means off).
 */
export class ConfigAusPostPolicy {
  constructor(
    private readonly markets: MarketRegistry,
    private readonly credentials: AusPostCredentials,
  ) {}

  /** The settings for a call, or null when Australia Post is off for the Market. */
  settings(marketId: MarketId): AusPostMarketSettings | null {
    const market = this.markets.get(marketId);
    const config = market.shipping?.auspost;
    const apiKey = this.#own(this.credentials.apiKeys, marketId);
    const apiPassword = this.#own(this.credentials.apiPasswords, marketId);
    const accountNumber = this.#own(this.credentials.accountNumbers, marketId);
    if (
      config === undefined ||
      !config.enabled ||
      apiKey === undefined ||
      apiPassword === undefined ||
      accountNumber === undefined
    ) {
      return null;
    }
    return { config, currency: market.defaultCurrency, apiKey, apiPassword, accountNumber };
  }

  /** The fleet's capabilities in the Market, or null when it is off. */
  capabilities(market: MarketContext): AusPostCapabilities | null {
    const settings = this.settings(market.marketId);
    if (settings === null) return null;
    const { config } = settings;
    return {
      fleet: 'auspost',
      modes: [...config.modes],
      outsideCityAreasOnly: config.outsideCityAreasOnly,
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

  #own(map: Readonly<Record<string, string>>, marketId: string): string | undefined {
    return Object.hasOwn(map, marketId) ? map[marketId] : undefined;
  }
}
