import type { MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { FleetCapabilities } from '../domain/fleet';

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

  /**
   * What Australia Post declares for the Market, or null when it is off. Scheduled only (a
   * multi-day postal service: never instant or same day), ambient parcels only, and no buyer
   * window (`supportsWindow` false: a scheduled order that carries a window goes to another
   * fleet). `outsideCityAreasOnly` and `serviceAreas` come from the Market's config; the order
   * value cap is in the Market's default currency, never a constant of the core.
   */
  capabilities(market: MarketContext): FleetCapabilities | null {
    const settings = this.settings(market.marketId);
    if (settings === null) return null;
    const { config } = settings;
    return {
      fleet: 'auspost',
      methods: config.modes.includes('scheduled') ? ['scheduled'] : [],
      serviceAreas: [...config.serviceAreas],
      outsideCityAreasOnly: config.outsideCityAreasOnly,
      temperatures: ['ambient'],
      maxItemWeightGrams: config.limits.maxItemWeightGrams,
      maxItems: config.limits.maxItems,
      maxOrderValue: {
        amount: BigInt(config.limits.maxOrderValueMinor),
        currency: settings.currency,
      },
      prohibitedClasses: [...config.prohibitedClasses],
      // No idempotency key is documented, so a shipment is created once and never repeated.
      idempotentBooking: false,
      supportsWindow: false,
    };
  }

  #own(map: Readonly<Record<string, string>>, marketId: string): string | undefined {
    return Object.hasOwn(map, marketId) ? map[marketId] : undefined;
  }
}
