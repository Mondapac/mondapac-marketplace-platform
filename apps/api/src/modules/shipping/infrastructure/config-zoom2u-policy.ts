import type { MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CarrierMethod } from '../domain/booking-service';
import type { FleetCapabilities } from '../domain/fleet';

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

  /**
   * What Zoom2u declares for the Market, or null when it is off. The methods follow the
   * configured modes (on demand: instant and same day; scheduled: the buyer's window). The order
   * value cap is in the Market's default currency, never a constant of the core.
   */
  capabilities(market: MarketContext): FleetCapabilities | null {
    const settings = this.settings(market.marketId);
    if (settings === null) return null;
    const { config } = settings;
    const methods: CarrierMethod[] = [
      ...(config.modes.includes('on_demand') ? (['instant', 'same_day'] as const) : []),
      // Scheduled needs the buyer's window, so it is declared only when the window is supported.
      ...(config.modes.includes('scheduled') && config.supportsWindow
        ? (['scheduled'] as const)
        : []),
    ];
    return {
      fleet: 'zoom2u',
      methods,
      serviceAreas: [...config.serviceAreas],
      outsideCityAreasOnly: false,
      temperatures: [...config.temperatures],
      maxItemWeightGrams: config.limits.maxItemWeightGrams,
      maxItems: config.limits.maxItems,
      maxOrderValue: {
        amount: BigInt(config.limits.maxOrderValueMinor),
        currency: settings.currency,
      },
      prohibitedClasses: [...config.prohibitedClasses],
      // Zoom2u documents no idempotency key (`PurchaseOrderNumber` is a label), so a booking is
      // a single attempt and a lost answer is "carrier-unknown".
      idempotentBooking: false,
      supportsWindow: config.supportsWindow && config.modes.includes('scheduled'),
    };
  }
}
