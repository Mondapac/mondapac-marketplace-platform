import { Temporal } from '@mondapac/shared-kernel';

// The on-call roster (decision T7: Kazem, Hossein and Mojtaba on weekly rotation, Ali the incident
// commander, Hassan the security owner) and business hours (decision T3). Read from a server file
// named by SECURITY_ON_CALL_FILE, never from the repository: it holds people's addresses and phone
// numbers (docs/design/data/security.md 5). Pure functions of the roster and an instant.

export interface RosterMember {
  /** Lowercase code, the recipient of a delivery row (e.g. "kazem"). */
  readonly code: string;
  /** Display name for the page. */
  readonly name: string;
  /** The member's admin account, when they have one: who may resolve an S1 alert. */
  readonly accountId: string | null;
  readonly email: string | null;
  /** E.164. */
  readonly phone: string | null;
}

export interface BusinessHours {
  /** IANA zone the hours, the rotation and the digests are read in. */
  readonly zone: string;
  /** Minutes after local midnight, start inclusive and end exclusive. */
  readonly startMinute: number;
  readonly endMinute: number;
  /** ISO weekdays, 1 Monday to 7 Sunday. */
  readonly days: readonly number[];
}

export interface OnCallRoster {
  readonly hours: BusinessHours;
  readonly members: readonly RosterMember[];
  /** Codes in rotation order; one member a week. */
  readonly rotation: readonly string[];
  /** The local date and minute the first member's week starts; later weeks hand over then too. */
  readonly rotationStart: Temporal.PlainDateTime;
  readonly incidentCommander: string;
  readonly securityOwner: string;
}

export function memberOf(roster: OnCallRoster, code: string): RosterMember | null {
  return roster.members.find((member) => member.code === code) ?? null;
}

/** Which week of the rotation an instant falls in (negative before the start). */
function weekIndex(roster: OnCallRoster, now: Temporal.Instant): number {
  const start = roster.rotationStart.toZonedDateTime(roster.hours.zone);
  const local = now.toZonedDateTimeISO(roster.hours.zone);
  const weeks = start.until(local, { largestUnit: 'weeks' }).weeks;
  // `until` truncates towards zero: before the start, step back one more week.
  return Temporal.ZonedDateTime.compare(local, start) < 0 &&
    Temporal.ZonedDateTime.compare(start.add({ weeks }), local) !== 0
    ? weeks - 1
    : weeks;
}

const mod = (value: number, size: number): number => ((value % size) + size) % size;

/** The rotation code on call at `now`, `offset` weeks later (0 is now). */
export function onCallAt(roster: OnCallRoster, now: Temporal.Instant, offset = 0): string {
  return roster.rotation[mod(weekIndex(roster, now) + offset, roster.rotation.length)]!;
}

/** When the on-call week that holds `now` began, plus `offset` weeks, as an instant. */
export function weekStartAt(
  roster: OnCallRoster,
  now: Temporal.Instant,
  offset = 0,
): Temporal.Instant {
  return roster.rotationStart
    .toZonedDateTime(roster.hours.zone)
    .add({ weeks: weekIndex(roster, now) + offset })
    .toInstant();
}

/**
 * The S1 escalation chain at `now`: the member on call, then the rest of the rotation in order,
 * then the incident commander (plan section 4: every 10 minutes to the next until acknowledged).
 */
export function escalationChain(roster: OnCallRoster, now: Temporal.Instant): readonly string[] {
  const first = weekIndex(roster, now);
  const size = roster.rotation.length;
  const chain = Array.from(
    { length: size },
    (_, index) => roster.rotation[mod(first + index, size)]!,
  );
  if (!chain.includes(roster.incidentCommander)) chain.push(roster.incidentCommander);
  return chain;
}

const minuteOfDay = (time: Temporal.ZonedDateTime): number => time.hour * 60 + time.minute;

export function isBusinessTime(hours: BusinessHours, now: Temporal.Instant): boolean {
  const local = now.toZonedDateTimeISO(hours.zone);
  const minute = minuteOfDay(local);
  return (
    hours.days.includes(local.dayOfWeek) && minute >= hours.startMinute && minute < hours.endMinute
  );
}

/** `now` when it is business time, else the start of the next business period. */
export function nextBusinessStart(hours: BusinessHours, now: Temporal.Instant): Temporal.Instant {
  if (isBusinessTime(hours, now)) return now;
  const local = now.toZonedDateTimeISO(hours.zone);
  for (let day = 0; day <= 7; day += 1) {
    const date = local.toPlainDate().add({ days: day });
    const start = date
      .toPlainDateTime({ hour: Math.floor(hours.startMinute / 60), minute: hours.startMinute % 60 })
      .toZonedDateTime(hours.zone);
    if (hours.days.includes(date.dayOfWeek) && Temporal.ZonedDateTime.compare(start, local) > 0) {
      return start.toInstant();
    }
  }
  // Unreachable with at least one business day (the roster parser requires one).
  return now;
}

/** The local date of `now`, `YYYY-MM-DD`: the daily digest's period. */
export function localDate(hours: BusinessHours, now: Temporal.Instant): string {
  return now.toZonedDateTimeISO(hours.zone).toPlainDate().toString();
}

/** The ISO week of `now`, `YYYY-Www`: the weekly digest's period. */
export function localIsoWeek(hours: BusinessHours, now: Temporal.Instant): string {
  const local = now.toZonedDateTimeISO(hours.zone);
  const year = local.yearOfWeek ?? local.year;
  const week = local.weekOfYear ?? 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}
