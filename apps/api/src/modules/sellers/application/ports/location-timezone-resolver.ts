import type { MarketContext } from '@mondapac/shared-kernel';

/**
 * A device position, already validated and rounded by the use case (finite, in range, two
 * decimals). It lives for the call only: never stored, logged, audited, put in an event,
 * telemetry or AI input (spike 3 record, privacy).
 */
export interface DevicePosition {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * `LocationTimezoneResolver` (spike 3 record, part 2b): the IANA zone of a device position, as a
 * hint for a draft whose zone nobody set. `null` means no suggestion: the `none` adapter, a
 * point outside the Market, or an error. It never returns an offset and a caller never trusts
 * it beyond the region list of the address (the address wins; `zoneAfterAddressSave`).
 *
 * Only `my-file.save-address` may import this port (a `pnpm boundaries` rule, to be added with
 * the first real adapter). The adapter per Market is chosen by configuration
 * (`sellers.locationTimezone.adapter`, default `none`) once that key exists; until then the
 * module binds `none`.
 */
export interface LocationTimezoneResolver {
  zoneFor(market: MarketContext, position: DevicePosition): Promise<string | null>;
}

export const LOCATION_TIMEZONE_RESOLVER = Symbol('LOCATION_TIMEZONE_RESOLVER');
