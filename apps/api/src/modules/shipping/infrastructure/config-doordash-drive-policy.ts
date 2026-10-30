import type { MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CarrierMethod } from '../domain/booking-service';
import type { FleetCapabilities } from '../domain/fleet';

export type DoorDashDriveConfig = NonNullable<
  NonNullable<MarketConfig['shipping']>['doordashDrive']
>;

/** The DoorDash Drive credentials of the Region Stack, as `MARKET=value` maps (see `AppConfig`). */
export interface DoorDashDriveCredentials {
  readonly developerIds: Readonly<Record<string, string>>;
  readonly keyIds: Readonly<Record<string, string>>;
  readonly signingSecrets: Readonly<Record<string, string>>;
}

/** What one Market's DoorDash Drive is, ready for a call: settings, credentials and the country. */
export interface DoorDashDriveMarketSettings {
  readonly config: DoorDashDriveConfig;
  readonly country: string;
  /** The Market's default currency: the one the limits and the order value are in. */
  readonly currency: string;
  readonly developerId: string;
  readonly keyId: string;
  readonly signingSecret: string;
}

/**
 * DoorDash Drive's settings of a Market from `shipping.doordashDrive`, on only when the section says
 * `enabled`, the Market has an address country and the Region Stack holds all three credentials (developer id, key id, signing secret)
 * (fail closed: absent means off).
 */
export class ConfigDoorDashDrivePolicy {
  constructor(
    private readonly markets: MarketRegistry,
    private readonly credentials: DoorDashDriveCredentials,
  ) {}

  /** The settings for a call, or null when DoorDash Drive is off for the Market. */
  settings(marketId: MarketId): DoorDashDriveMarketSettings | null {
    const market = this.markets.get(marketId);
    const config = market.shipping?.doordashDrive;
    const country = market.customers?.address.countryCode;
    const pick = (values: Readonly<Record<string, string>>): string | undefined =>
      Object.hasOwn(values, marketId) ? values[marketId] : undefined;
    const developerId = pick(this.credentials.developerIds);
    const keyId = pick(this.credentials.keyIds);
    const signingSecret = pick(this.credentials.signingSecrets);
    if (
      config === undefined ||
      !config.enabled ||
      country === undefined ||
      developerId === undefined ||
      keyId === undefined ||
      signingSecret === undefined
    ) {
      return null;
    }
    return {
      config,
      country,
      currency: market.defaultCurrency,
      developerId,
      keyId,
      signingSecret,
    };
  }

  /**
   * What DoorDash Drive declares for the Market, or null when it is off. The methods follow the
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
      fleet: 'doordash_drive',
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
      // We supply DoorDash's `external_delivery_id` (derived from the seller order), and a repeated
      // id answers 409 `duplicate_delivery_id`. The adapter reads the existing delivery back, so
      // a retry after a lost answer finds the first booking instead of making a second one.
      idempotentBooking: true,
      supportsWindow: true,
    };
  }
}
