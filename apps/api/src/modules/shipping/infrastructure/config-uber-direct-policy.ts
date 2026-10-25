import type { MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CarrierMethod } from '../domain/booking-service';
import type { FleetCapabilities } from '../domain/fleet';

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
  /** The Market's default currency: the one the limits and the order value are in. */
  readonly currency: string;
  readonly customerId: string;
  readonly clientId: string;
  readonly clientSecret: string;
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
    return {
      config,
      country,
      currency: market.defaultCurrency,
      customerId,
      clientId,
      clientSecret,
    };
  }

  /**
   * What Uber Direct declares for the Market, or null when it is off. The methods follow the
   * configured modes (on demand: instant and same day; scheduled: the buyer's window). The order
   * value cap is in the Market's default currency, never a constant of the core.
   */
  capabilities(market: MarketContext): FleetCapabilities | null {
    const settings = this.settings(market.marketId);
    if (settings === null) return null;
    const { config } = settings;
    const methods: CarrierMethod[] = [
      ...(config.modes.includes('on_demand') ? (['instant', 'same_day'] as const) : []),
      ...(config.modes.includes('scheduled') ? (['scheduled'] as const) : []),
    ];
    return {
      fleet: 'uber_direct',
      methods,
      serviceAreas: [...config.serviceAreas],
      outsideCityAreasOnly: false,
      temperatures: [...config.temperatures],
      maxItemWeightGrams: config.limits.maxItemWeightGrams,
      maxItems: config.limits.maxItems,
      maxOrderValue: {
        amount: BigInt(config.limits.maxOrderValueMinor),
        currency: this.markets.get(market.marketId).defaultCurrency,
      },
      prohibitedClasses: [...config.prohibitedClasses],
      // Uber's dedupe of `POST deliveries` by `external_id` is not verified, so booking is a
      // single attempt and a lost answer is "carrier-unknown". Switch to true only after Uber's
      // documented dedupe field is confirmed on the test account (and the client may retry then).
      idempotentBooking: false,
      supportsWindow: true,
    };
  }
}
