import type { MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { MarketConfig } from '../../../platform/market-config/market-config';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import type { CarrierPolicy, RealTimeCarrierSettings } from '../application/ports/carrier-policy';

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

  realTimeCarrier(market: MarketContext): RealTimeCarrierSettings | null {
    const settings = this.config(market.marketId);
    if (settings === null) return null;
    return {
      displayName: settings.displayName,
      serviceAreas: settings.serviceAreas,
      parcel: settings.parcel,
      mode: settings.mode,
    };
  }

  serviceAreaOf(market: MarketContext, postcode: string): string | null {
    return this.areas.areaFor(market.marketId, postcode)?.code ?? null;
  }
}
