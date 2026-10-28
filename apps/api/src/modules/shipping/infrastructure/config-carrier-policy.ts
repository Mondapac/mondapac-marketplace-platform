import type { MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import type {
  CarrierPolicy,
  ParcelDefaults,
  RealTimeCarrierSettings,
} from '../application/ports/carrier-policy';
import type { FleetCapabilities, FleetCode } from '../domain/fleet';
import { capabilitiesOf, type FleetEntry } from './fleet-config';

const DEFAULT_PARCEL: ParcelDefaults = {
  weightGrams: 5000,
  volumeLitres: 20,
  temperature: 'ambient',
};

/** What the people see when a Market names no display name for a fleet. */
export const FLEET_NAMES: Readonly<Record<FleetCode, string>> = {
  mondapac_drive: 'Mondapac Drive',
  uber_direct: 'Uber Direct',
  zoom2u: 'Zoom2u',
  auspost: 'Australia Post',
  fake_test: 'Test Fleet',
};

export type RealTimeCarrierConfig = NonNullable<
  NonNullable<MarketConfig['shipping']>['realTimeCarrier']
>;

/**
 * The real-time carrier of a Market from `shipping.realTimeCarrier`, on only when the Region
 * Stack also holds the carrier's API key and webhook secret for that Market (fail closed).
 */
export class ConfigCarrierPolicy implements CarrierPolicy {
  constructor(
    private readonly markets: MarketRegistry,
    private readonly areas: ServiceAreaDirectory,
    private readonly secrets: {
      readonly apiKeys: Readonly<Record<string, string>>;
      readonly webhookSecrets: Readonly<Record<string, string>>;
    },
  ) {}

  /** The raw section, for the adapter: null when the carrier is off for the Market. */
  config(marketId: MarketId): RealTimeCarrierConfig | null {
    const settings = this.markets.get(marketId).shipping?.realTimeCarrier;
    if (
      settings === undefined ||
      !Object.hasOwn(this.secrets.apiKeys, marketId) ||
      !Object.hasOwn(this.secrets.webhookSecrets, marketId)
    ) {
      return null;
    }
    return settings;
  }

  /**
   * What Mondapac Drive declares for the Market, or null when it is off: no `realTimeCarrier`
   * settings, or no key or webhook secret. An explicit `shipping.fleets.mondapac_drive` entry
   * refines the declaration (and `enabled: false` switches the fleet off); without one, the legacy
   * `realTimeCarrier` declares every method over its service areas and its parcel temperature.
   */
  driveCapabilities(marketId: MarketId): FleetCapabilities | null {
    const legacy = this.config(marketId);
    if (legacy === null) return null;
    const currency = this.markets.get(marketId).defaultCurrency;
    const adapter = { idempotentBooking: true, supportsWindow: true } as const;
    const entry = this.fleetEntry(marketId, 'mondapac_drive');
    if (entry !== undefined) return capabilitiesOf('mondapac_drive', entry, currency, adapter);
    return capabilitiesOf(
      'mondapac_drive',
      {
        enabled: true,
        serviceAreas: [...legacy.serviceAreas],
        outsideCityAreasOnly: false,
        methods: ['instant', 'same_day', 'scheduled'],
        temperatures: [legacy.parcel.temperature],
        maxItemWeightGrams: null,
        maxItems: null,
        maxOrderValueMinor: null,
        prohibitedClasses: [],
      },
      currency,
      adapter,
    );
  }

  /** The `shipping.fleets` entry of a fleet in the Market, or undefined when none is listed. */
  fleetEntry(marketId: MarketId, fleet: FleetCode): FleetEntry | undefined {
    return this.markets.get(marketId).shipping?.fleets?.[fleet];
  }

  realTimeCarrier(market: MarketContext): RealTimeCarrierSettings | null {
    const settings = this.config(market.marketId);
    if (settings === null) return null;
    return {
      displayName: settings.displayName,
      serviceAreas: settings.serviceAreas,
      parcel: settings.parcel,
      mode: settings.mode,
      quoteBounds: settings.quoteBounds,
    };
  }

  parcelDefaults(market: MarketContext): ParcelDefaults {
    return this.config(market.marketId)?.parcel ?? DEFAULT_PARCEL;
  }

  fleetDisplayName(market: MarketContext, fleet: FleetCode): string {
    const entry = this.fleetEntry(market.marketId, fleet);
    if (entry?.displayName !== undefined) return entry.displayName;
    if (fleet === 'mondapac_drive') {
      return (
        this.markets.get(market.marketId).shipping?.realTimeCarrier?.displayName ??
        FLEET_NAMES[fleet]
      );
    }
    return FLEET_NAMES[fleet];
  }

  serviceAreaOf(market: MarketContext, postcode: string): string | null {
    return this.areas.areaFor(market.marketId, postcode)?.code ?? null;
  }
}
