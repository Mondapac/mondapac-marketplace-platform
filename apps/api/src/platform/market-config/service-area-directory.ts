import type { MarketId } from '@mondapac/shared-kernel';
import { normalisePostcode, type PostcodeInterval } from './postcode-entry';

export { normalisePostcode, type PostcodeInterval };

/** A ServiceArea as `sellers` and `shipping` read it (ADR-0005 decision 7). */
export interface ServiceArea {
  readonly code: string;
  /** Display names by language tag; always has "en" (config boot check). */
  readonly names: Readonly<Record<string, string>>;
  /** The Market region (state) the area sits in, or null when the Market has none. */
  readonly region: string | null;
  readonly sellerOnboardingEnabled: boolean;
  readonly deliveryEnabled: boolean;
}

/** One side of a lane: one area, every area of a region (state), or every area of the Market. */
export type LaneEnd =
  { readonly area: string } | { readonly region: string } | { readonly all: true };

/** A cross-area selling rule: a seller in `from` may serve a buyer in `to`. */
export interface AreaLane {
  readonly from: LaneEnd;
  readonly to: LaneEnd;
}

/**
 * The cross-area selling rules of one Market. `enabled` is the Market switch, OFF unless the
 * file says otherwise; while it is off the lanes are ignored and a seller serves only its own area.
 */
export interface CrossAreaSelling {
  readonly enabled: boolean;
  readonly lanes: readonly AreaLane[];
}

export interface ServiceAreaDefinition extends ServiceArea {
  /** Digits-only postcodes and ranges. */
  readonly intervals: readonly PostcodeInterval[];
  /** Other postcodes, normalised (see `normalisePostcode`). */
  readonly exact: ReadonlySet<string>;
}

/**
 * Which ServiceArea a postcode falls in (ADR-0005 decision 7). Read-only and built once at
 * boot from `config/service-areas/`; an area does not own a time zone. There is no default:
 * a postcode no area lists, a Market with no areas and a Market this Region Stack does not
 * host all answer `undefined`, so a caller treats the address as outside every area.
 */
export class ServiceAreaDirectory {
  constructor(
    private readonly areasByMarket: ReadonlyMap<MarketId, readonly ServiceAreaDefinition[]>,
    private readonly crossAreaByMarket: ReadonlyMap<MarketId, CrossAreaSelling> = new Map(),
  ) {}

  /**
   * Whether a seller in `sellerAreaCode` may serve a buyer in `buyerAreaCode`. Fail-closed: the
   * same area always works; any other pair needs the Market switch ON and a lane that names
   * both sides. An unknown or missing area, a Market with no rules and an unknown Market all
   * answer false.
   */
  sellerMayServe(
    marketId: MarketId,
    sellerAreaCode: string | null,
    buyerAreaCode: string | null,
  ): boolean {
    if (sellerAreaCode === null || buyerAreaCode === null) return false;
    const areas = this.areasByMarket.get(marketId) ?? [];
    const seller = areas.find((area) => area.code === sellerAreaCode);
    const buyer = areas.find((area) => area.code === buyerAreaCode);
    if (seller === undefined || buyer === undefined) return false;
    if (seller.code === buyer.code) return true;
    const rules = this.crossAreaByMarket.get(marketId);
    if (rules === undefined || !rules.enabled) return false;
    const matches = (end: LaneEnd, area: ServiceAreaDefinition): boolean =>
      'all' in end ? true : 'area' in end ? end.area === area.code : end.region === area.region;
    return rules.lanes.some((lane) => matches(lane.from, seller) && matches(lane.to, buyer));
  }

  /** Whether the Market switch for cross-area selling is ON. */
  crossAreaSellingEnabled(marketId: MarketId): boolean {
    return this.crossAreaByMarket.get(marketId)?.enabled === true;
  }

  areaFor(marketId: MarketId, postcode: string): ServiceArea | undefined {
    if (typeof postcode !== 'string') return undefined;
    const normalised = normalisePostcode(postcode);
    // Config is ASCII only; case folding must not turn other characters into a match (ß, ſ).
    if (normalised === '' || /[^\x21-\x7e]/u.test(normalised)) return undefined;
    const digits = /^\d{1,10}$/u.test(normalised) ? Number(normalised) : undefined;
    for (const area of this.areasByMarket.get(marketId) ?? []) {
      const found =
        area.exact.has(normalised) ||
        (digits !== undefined &&
          area.intervals.some(
            (interval) =>
              interval.length === normalised.length &&
              interval.low <= digits &&
              digits <= interval.high,
          ));
      if (found) {
        return {
          code: area.code,
          names: area.names,
          region: area.region,
          sellerOnboardingEnabled: area.sellerOnboardingEnabled,
          deliveryEnabled: area.deliveryEnabled,
        };
      }
    }
    return undefined;
  }

  /** Every area of a Market, for admin lists and filters. Empty for an unknown Market. */
  areasOf(marketId: MarketId): readonly ServiceArea[] {
    return (this.areasByMarket.get(marketId) ?? []).map(
      ({ code, names, region, sellerOnboardingEnabled, deliveryEnabled }) => ({
        code,
        names,
        region,
        sellerOnboardingEnabled,
        deliveryEnabled,
      }),
    );
  }
}
