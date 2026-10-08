import { Temporal } from '@mondapac/shared-kernel';

/**
 * A half-open span of instants (sellers design 2.4 rule 4; ADR-0009 V2): `validFrom` is inclusive,
 * `validTo` exclusive, `null` is open. The no-overlap rule across a seller's periods is the
 * database's (`EXCLUDE USING gist`); the aggregate checks it first so the caller gets a code.
 *
 * Designed with its first consumer (tax registration, slice 3). It lives in `sellers` until a
 * second module needs it; it then moves to the shared kernel (ADR-0020 decision 7, PF 3.8).
 */
export interface EffectivePeriod {
  readonly validFrom: Temporal.Instant;
  readonly validTo: Temporal.Instant | null;
}

/** Whether `at` falls inside the period: from inclusive, to exclusive. */
export function contains(period: EffectivePeriod, at: Temporal.Instant): boolean {
  if (Temporal.Instant.compare(at, period.validFrom) < 0) return false;
  return period.validTo === null || Temporal.Instant.compare(at, period.validTo) < 0;
}

/** Whether two half-open periods share an instant. A period that ends where the next starts does not overlap it. */
export function overlaps(a: EffectivePeriod, b: EffectivePeriod): boolean {
  const aEndsBeforeBStarts =
    a.validTo !== null && Temporal.Instant.compare(a.validTo, b.validFrom) <= 0;
  const bEndsBeforeAStarts =
    b.validTo !== null && Temporal.Instant.compare(b.validTo, a.validFrom) <= 0;
  return !aEndsBeforeBStarts && !bEndsBeforeAStarts;
}

/** A period is valid when it is not empty: `validTo` is after `validFrom` (the database CHECK). */
export function isWellFormed(period: EffectivePeriod): boolean {
  return period.validTo === null || Temporal.Instant.compare(period.validTo, period.validFrom) > 0;
}

/**
 * The instant of 00:00 on a local date in the owning party's IANA zone (ADR-0005 decision 3;
 * sellers design 2.4 rule 4). A zone that skips midnight (a daylight-saving change at 00:00)
 * gives the first instant of that day, which is what `Temporal`'s default disambiguation returns.
 */
export function startOfLocalDate(localDate: Temporal.PlainDate, zone: string): Temporal.Instant {
  return localDate.toZonedDateTime({ timeZone: zone }).toInstant();
}

/** The local date of an instant in a zone. */
export function localDateOf(at: Temporal.Instant, zone: string): Temporal.PlainDate {
  return at.toZonedDateTimeISO(zone).toPlainDate();
}
