import type { MarketContext } from '@mondapac/shared-kernel';
import type { AddressFormatSpec } from '../../domain/address';
import type { RegionZones } from '../../domain/zone';

/**
 * `AddressFormat` (sellers design 4.2): the Market's address format, from the `sellers.address`
 * section of its configuration. Null for a Market with no `sellers` section: no seller can
 * complete a draft there, and nothing falls back to another Market's format.
 */
export interface AddressFormats {
  formatOf(market: MarketContext): AddressFormatSpec | null;
}

export const ADDRESS_FORMATS = Symbol('ADDRESS_FORMATS');

/**
 * `TimezoneResolver` (sellers design 4.2, amended by the spike 3 record): a region's default zone
 * and the closed list a seller chooses from, from `sellers.timezones.byRegion`. Null for a region
 * the Market does not list, for a Market without a region field, and for a Market with no
 * `sellers` section. Never an offset (ADR-0005 decision 1).
 */
export interface TimezoneResolver {
  zonesOf(market: MarketContext, region: string | null): RegionZones | null;
}

export const TIMEZONE_RESOLVER = Symbol('TIMEZONE_RESOLVER');

/** A ServiceArea as the draft records it (sellers design 4.3). */
export interface DraftServiceArea {
  readonly code: string;
  readonly sellerOnboardingEnabled: boolean;
}

/**
 * The platform `ServiceAreaDirectory` as `sellers` reads it (design 4.3): the area a postcode of
 * the Market falls in, or null when it falls in none. No default area.
 */
export interface ServiceAreas {
  areaFor(market: MarketContext, postcode: string): DraftServiceArea | null;
}

export const SERVICE_AREAS = Symbol('SERVICE_AREAS');

/**
 * The areas of a Market that take new sellers now (the admin list's "outside service area"
 * filter, design 7.8): the codes of the platform `ServiceAreaDirectory` with onboarding enabled.
 * Empty for a Market with no areas; no default area.
 */
export interface OnboardingAreas {
  openCodes(market: MarketContext): readonly string[];
}

export const ONBOARDING_AREAS = Symbol('ONBOARDING_AREAS');
