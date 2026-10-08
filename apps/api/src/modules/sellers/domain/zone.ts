import { err, ok, type Result } from '@mondapac/shared-kernel';

/**
 * Who set the seller's operating zone (data design 3.1 `timezone_source`; spike 3 record):
 * `default` the region's default, `browser` and `location` an accepted hint, `seller` and
 * `admin` a person's choice. `location` is written only by the later location-hint slice.
 */
export const TIMEZONE_SOURCES = ['default', 'browser', 'location', 'seller', 'admin'] as const;
export type TimezoneSource = (typeof TIMEZONE_SOURCES)[number];

/** A region's zones from Market configuration (design 4.1): `default` is in `selectable`. */
export interface RegionZones {
  readonly default: string;
  readonly selectable: readonly string[];
}

/** The zone columns of the draft (data design 3.1): all three are set together. */
export interface ZoneState {
  /** IANA id, never an offset (ADR-0005 decision 1). */
  readonly operatingTimezone: string;
  readonly timezoneSource: TimezoneSource;
  /** The zone the operating address gives: its region's default (guardrail 3). */
  readonly addressTimezone: string;
}

export type ZoneNotSelectable = { readonly code: 'timezone.not-selectable' };

/** What a save offers for the zone: a person's choice and a hint, both untrusted input. */
export interface ZoneChoice {
  /** `undefined` when the request makes no choice; anything else must be on the list. */
  readonly chosen: unknown;
  /** The browser's own zone: applied only under the rules below, otherwise dropped silently. */
  readonly hint: unknown;
}

/** Hints never come from a person, so a later hint may replace them. */
const NOBODY_SET: ReadonlySet<TimezoneSource> = new Set(['default', 'browser', 'location']);

/** Exact string membership: no normalisation, no case folding, no alias (mini-review 2026-10-08). */
const onList = (zones: RegionZones, zone: unknown): zone is string =>
  typeof zone === 'string' && zones.selectable.includes(zone);

/**
 * The zone of the draft after an address save (spike 3 record; sellers design 4.2
 * `TimezoneResolver`, the domain rule `chooseZone`). `zones` are those of the saved operating
 * address's region, or null when the Market gives the address none.
 *
 * 1. A chosen zone must be on the region's list, compared as an exact string: never free text,
 *    an offset, an alias or `Etc/*` (the list holds none of these, boot-checked). Otherwise
 *    `timezone.not-selectable` and nothing changes.
 * 2. Without a choice, a current zone that is still on the list is kept (a default zone moves to
 *    the new default); a zone that is not on the new list resets to the default.
 * 3. A hint applies only to a draft whose zone no seller or admin set, and only if it is on the
 *    list (the address wins); otherwise it is dropped without an error.
 *
 * `addressTimezone` is always the region's default.
 */
export function zoneAfterAddressSave(
  current: ZoneState | null,
  zones: RegionZones | null,
  choice: ZoneChoice,
): Result<ZoneState | null, ZoneNotSelectable> {
  if (zones === null) {
    return choice.chosen === undefined ? ok(null) : err({ code: 'timezone.not-selectable' });
  }
  const addressTimezone = zones.default;
  if (choice.chosen !== undefined) {
    if (!onList(zones, choice.chosen)) return err({ code: 'timezone.not-selectable' });
    return ok({ operatingTimezone: choice.chosen, timezoneSource: 'seller', addressTimezone });
  }
  const nobodySet = current === null || NOBODY_SET.has(current.timezoneSource);
  if (nobodySet && onList(zones, choice.hint)) {
    return ok({ operatingTimezone: choice.hint, timezoneSource: 'browser', addressTimezone });
  }
  if (
    current !== null &&
    current.timezoneSource !== 'default' &&
    onList(zones, current.operatingTimezone)
  ) {
    return ok({ ...current, addressTimezone });
  }
  return ok({ operatingTimezone: addressTimezone, timezoneSource: 'default', addressTimezone });
}
