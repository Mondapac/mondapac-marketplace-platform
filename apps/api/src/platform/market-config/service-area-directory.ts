import type { MarketId } from '@mondapac/shared-kernel';

/** A ServiceArea as `sellers` and `shipping` read it (ADR-0005 decision 7). */
export interface ServiceArea {
  readonly code: string;
  readonly sellerOnboardingEnabled: boolean;
  readonly deliveryEnabled: boolean;
}

/** One digits-only postcode interval, both ends the same length so the compare is numeric. */
export interface PostcodeInterval {
  readonly length: number;
  readonly low: number;
  readonly high: number;
}

export interface ServiceAreaDefinition extends ServiceArea {
  /** Digits-only postcodes and ranges. */
  readonly intervals: readonly PostcodeInterval[];
  /** Other postcodes, normalised (see `normalisePostcode`). */
  readonly exact: ReadonlySet<string>;
}

/** Upper-case and without whitespace, so "sw1a 1aa" and "SW1A1AA" are the same postcode. */
export function normalisePostcode(postcode: string): string {
  return postcode.replace(/\s+/gu, '').toUpperCase();
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
  ) {}

  areaFor(marketId: MarketId, postcode: string): ServiceArea | undefined {
    const normalised = normalisePostcode(postcode);
    if (normalised === '') return undefined;
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
      ({ code, sellerOnboardingEnabled, deliveryEnabled }) => ({
        code,
        sellerOnboardingEnabled,
        deliveryEnabled,
      }),
    );
  }
}
