import { Temporal } from '@mondapac/shared-kernel';
import { localTimeToMinute, PAYOUT_WEEKDAYS, type PayoutWeekday } from './payout-terms';

// The payout schedule (Phase 5 package 6d; G2 4.6): a seller is due when a slot, a weekday and an
// HH:mm in the seller's own approved operating zone, lies in `(lastSlotAt, now]`. Pure functions of
// instants and a zone; the zone is an argument, never a default, and the Market's zone is never a
// fallback (ADR-0005). Daylight saving: a local time that does not exist is moved forward to the
// first valid instant (the instant the clocks change), an ambiguous one takes the earlier instant.
// Several slots missed during a downtime give one answer, the latest, so one payout is made.

export interface ScheduleTerms {
  readonly weekdays: readonly PayoutWeekday[];
  /** HH:mm in the seller's zone. */
  readonly localTime: string;
}

/** The longest stretch looked at when a lot of slots were missed: only the latest one matters. */
const LOOK_BACK_DAYS = 400;
/** A slot is found within a week; two more days cover a day shifted by a zone change. */
const LOOK_AHEAD_DAYS = 9;

/** Whether `zone` is an IANA zone this runtime knows. */
export function isKnownZone(zone: string): boolean {
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant of `localTime` on the local `date` in `zone`. A time the clocks skip is the first
 * valid instant after the gap; a time that happens twice is the first of the two.
 */
export function slotOnDate(
  date: Temporal.PlainDate,
  localTime: string,
  zone: string,
): Temporal.Instant {
  const minute = localTimeToMinute(localTime);
  if (minute === null) throw new RangeError('slotOnDate: localTime must be HH:mm');
  const wanted = date.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 });
  const earlier = wanted.toZonedDateTime(zone, { disambiguation: 'earlier' });
  if (Temporal.PlainDateTime.compare(earlier.toPlainDateTime(), wanted) === 0) {
    return earlier.toInstant();
  }
  // The wall time does not exist: `earlier` is the instant before the gap, so the next transition
  // is the end of the gap.
  const transition = earlier.getTimeZoneTransition('next');
  return (transition ?? earlier).toInstant();
}

const weekdayNumbers = (weekdays: readonly PayoutWeekday[]): ReadonlySet<number> =>
  new Set(weekdays.map((day) => PAYOUT_WEEKDAYS.indexOf(day) + 1));

/**
 * Every slot in `(after, upTo]`, oldest first. The slot of a local date is looked for from the day
 * before `after` to the day after `upTo`, so a slot moved across midnight by a zone change is not
 * missed. A window longer than {@link LOOK_BACK_DAYS} days is cut to its last days.
 */
export function slotsBetween(
  terms: ScheduleTerms,
  zone: string,
  after: Temporal.Instant,
  upTo: Temporal.Instant,
): readonly Temporal.Instant[] {
  if (Temporal.Instant.compare(upTo, after) <= 0) return [];
  const days = weekdayNumbers(terms.weekdays);
  const first =
    Temporal.Instant.compare(upTo.subtract({ hours: LOOK_BACK_DAYS * 24 }), after) > 0
      ? upTo.subtract({ hours: LOOK_BACK_DAYS * 24 })
      : after;
  let date = first.toZonedDateTimeISO(zone).toPlainDate().subtract({ days: 1 });
  const last = upTo.toZonedDateTimeISO(zone).toPlainDate().add({ days: 1 });
  const slots: Temporal.Instant[] = [];
  while (Temporal.PlainDate.compare(date, last) <= 0) {
    if (days.has(date.dayOfWeek)) {
      const slot = slotOnDate(date, terms.localTime, zone);
      if (Temporal.Instant.compare(slot, after) > 0 && Temporal.Instant.compare(slot, upTo) <= 0) {
        slots.push(slot);
      }
    }
    date = date.add({ days: 1 });
  }
  return slots.sort((a, b) => Temporal.Instant.compare(a, b));
}

/** The latest slot in `(after, upTo]`, or null when none: the seller is not due. */
export function latestSlot(
  terms: ScheduleTerms,
  zone: string,
  after: Temporal.Instant,
  upTo: Temporal.Instant,
): Temporal.Instant | null {
  const slots = slotsBetween(terms, zone, after, upTo);
  return slots[slots.length - 1] ?? null;
}

/** The first slot after `instant`. */
export function nextSlotAfter(
  terms: ScheduleTerms,
  zone: string,
  instant: Temporal.Instant,
): Temporal.Instant {
  const days = weekdayNumbers(terms.weekdays);
  if (days.size === 0) throw new RangeError('nextSlotAfter: the terms have no weekday');
  let date = instant.toZonedDateTimeISO(zone).toPlainDate().subtract({ days: 1 });
  for (let step = 0; step < LOOK_AHEAD_DAYS + 1; step += 1) {
    if (days.has(date.dayOfWeek)) {
      const slot = slotOnDate(date, terms.localTime, zone);
      if (Temporal.Instant.compare(slot, instant) > 0) return slot;
    }
    date = date.add({ days: 1 });
  }
  throw new RangeError('nextSlotAfter: no slot found within a week');
}
