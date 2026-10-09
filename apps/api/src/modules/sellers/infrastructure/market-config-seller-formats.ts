import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import type {
  AddressFormats,
  DraftServiceArea,
  OnboardingAreas,
  ServiceAreas,
  TimezoneResolver,
} from '../application/ports/seller-market-formats';
import type { AddressFormatSpec } from '../domain/address';
import type { RegionZones } from '../domain/zone';

/**
 * `AddressFormat` and `TimezoneResolver` (sellers design 4.2) on the `sellers` section of the
 * Market's configuration, validated and frozen at boot (`market-config.ts`: the postcode pattern
 * grammar, the region list, each region's `{ default, selectable }` checked against the runtime
 * zone database). One adapter serves every Market: the format is data, not code. A Market this
 * Region Stack does not host throws (`MarketNotHostedError`); a Market without a `sellers`
 * section answers null, never another Market's values.
 */
export class MarketConfigSellerFormats implements AddressFormats, TimezoneResolver {
  readonly #formats = new Map<string, AddressFormatSpec>();

  constructor(private readonly markets: MarketRegistry) {}

  formatOf(market: MarketContext): AddressFormatSpec | null {
    const sellers = this.markets.get(market.marketId).sellers;
    if (sellers === undefined) return null;
    const known = this.#formats.get(market.marketId);
    if (known !== undefined) return known;
    const { address } = sellers;
    const format: AddressFormatSpec = Object.freeze({
      fields: Object.freeze(
        address.fields.map(({ key, labelKey, required, maxLength }) =>
          Object.freeze({ key, labelKey, required, maxLength }),
        ),
      ),
      postcodeField: address.postcodeField,
      regionField: address.regionField ?? null,
      postcodePattern: address.postcodePattern,
      regions: Object.freeze([...address.regions]),
    });
    this.#formats.set(market.marketId, format);
    return format;
  }

  zonesOf(market: MarketContext, region: string | null): RegionZones | null {
    const sellers = this.markets.get(market.marketId).sellers;
    if (sellers === undefined || region === null) return null;
    const byRegion = sellers.timezones.byRegion;
    // An own property only: a region name never reaches `Object.prototype`.
    if (!Object.hasOwn(byRegion, region)) return null;
    const zones = byRegion[region]!;
    return { default: zones.default, selectable: [...zones.selectable] };
  }
}

/** {@link ServiceAreas} on the platform `ServiceAreaDirectory` (design 4.3): code and flag only. */
export class DirectoryServiceAreas implements ServiceAreas, OnboardingAreas {
  constructor(private readonly directory: ServiceAreaDirectory) {}

  areaFor(market: MarketContext, postcode: string): DraftServiceArea | null {
    const area = this.directory.areaFor(market.marketId, postcode);
    return area === undefined
      ? null
      : { code: area.code, sellerOnboardingEnabled: area.sellerOnboardingEnabled };
  }

  openCodes(market: MarketContext): readonly string[] {
    return this.directory
      .areasOf(market.marketId)
      .filter((area) => area.sellerOnboardingEnabled)
      .map((area) => area.code);
  }
}
