import { Logger } from '@nestjs/common';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { DevicePosition, LocationTimezoneResolver } from '../ports/location-timezone-resolver';

const logger = new Logger('SellerLocationHint');

/** A short fixed wait: a slow resolver means no suggestion, never a slow save. */
export const LOCATION_RESOLVE_TIMEOUT_MS = 250;

const DECIMALS = 100;

/**
 * A device position from untrusted input: an object of two finite numbers in range, rounded
 * to two decimals here (about 1 km) whatever the client sent. Anything else is null.
 */
export function parsePosition(value: unknown): DevicePosition | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    latitude: Math.round(latitude * DECIMALS) / DECIMALS,
    longitude: Math.round(longitude * DECIMALS) / DECIMALS,
  };
}

/**
 * The zone a resolver suggests for an untrusted position, or null for no suggestion (spike 3
 * record). Never throws and never waits longer than {@link LOCATION_RESOLVE_TIMEOUT_MS}: an
 * invalid position, an error and a timeout all give null. The answer is untrusted text until the
 * domain rule checks it against the region's list. The position is never logged.
 */
export async function suggestedZoneFor(
  resolver: LocationTimezoneResolver,
  market: MarketContext,
  location: unknown,
): Promise<string | null> {
  const position = parsePosition(location);
  if (position === null) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), LOCATION_RESOLVE_TIMEOUT_MS);
    });
    const zone = await Promise.race([resolver.zoneFor(market, position), timeout]);
    return typeof zone === 'string' ? zone : null;
  } catch {
    logger.warn({ msg: 'sellers.location-hint.failed', marketId: market.marketId });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
