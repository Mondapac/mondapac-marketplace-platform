import { Temporal } from '@mondapac/shared-kernel';
import { at, closedObject, plainText, problem } from './fields';
import type { Problems } from './fields';

// The details of an event post. The times are instants; an author may type a local date and time
// (`2026-11-20T18:30`), read in the zone the organiser means (default: the Market's zone), or an
// instant with an offset. The one external link a post may carry is the registration URL: https
// only, and a reviewer approves it (the automatic check names it).

export const ATTENDANCES = ['offline', 'online', 'mixed'] as const;
export type Attendance = (typeof ATTENDANCES)[number];
export const EVENT_STATUSES = ['scheduled', 'postponed', 'rescheduled', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
/** The database holds the same cap (post_events_window_check). */
export const MAX_EVENT_HOURS = 744;
const MAX_URL = 500;

export interface EventDetails {
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly timeZone: string;
  readonly attendance: Attendance;
  readonly venueName: string | null;
  readonly address: string | null;
  readonly registrationUrl: string | null;
  readonly eventStatus: EventStatus;
  readonly statusMessage: string | null;
}

const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/u;
const ZONES = new Set(Intl.supportedValuesOf('timeZone'));

function instantOf(
  problems: Problems,
  path: string,
  value: unknown,
  zone: string,
): Temporal.Instant | null {
  if (value === undefined || value === null) {
    problem(problems, path, 'required');
    return null;
  }
  if (typeof value !== 'string' || value.length > 40) {
    problem(problems, path, 'type');
    return null;
  }
  try {
    if (LOCAL.test(value)) {
      return Temporal.PlainDateTime.from(value)
        .toZonedDateTime(zone, { disambiguation: 'reject' })
        .toInstant();
    }
    return Temporal.Instant.from(value);
  } catch {
    problem(problems, path, 'format');
    return null;
  }
}

/** An https URL without credentials, as the database accepts it. Null with a problem otherwise. */
export function parseHttpsUrl(problems: Problems, path: string, value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  if (typeof value !== 'string') {
    problem(problems, path, 'type');
    return null;
  }
  const text = value.trim();
  if (text.length > MAX_URL) {
    problem(problems, path, 'length');
    return null;
  }
  if (/[\s"<>\\]/u.test(text)) {
    problem(problems, path, 'format');
    return null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    problem(problems, path, 'format');
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    problem(problems, path, 'scheme');
    return null;
  }
  return text;
}

/** Validates the event part of a post's content. Never throws. */
export function parseEventDetails(
  problems: Problems,
  path: string,
  value: unknown,
  defaultZone: string,
): EventDetails | null {
  const before = problems.length;
  if (
    !closedObject(problems, path, value, [
      'startsAt',
      'endsAt',
      'timeZone',
      'attendance',
      'venueName',
      'address',
      'registrationUrl',
    ])
  ) {
    return null;
  }
  const zoneValue = value.timeZone ?? defaultZone;
  let zone = defaultZone;
  if (typeof zoneValue !== 'string' || !ZONES.has(zoneValue)) {
    problem(problems, at(path, 'timeZone'), 'value');
  } else {
    zone = zoneValue;
  }
  const startsAt = instantOf(problems, at(path, 'startsAt'), value.startsAt, zone);
  const endsAt = instantOf(problems, at(path, 'endsAt'), value.endsAt, zone);
  if (startsAt !== null && endsAt !== null) {
    if (Temporal.Instant.compare(endsAt, startsAt) <= 0) {
      problem(problems, at(path, 'endsAt'), 'before-start');
    } else if (Temporal.Instant.compare(endsAt, startsAt.add({ hours: MAX_EVENT_HOURS })) > 0) {
      problem(problems, at(path, 'endsAt'), 'too-long');
    }
  }
  const attendance = value.attendance;
  if (!(ATTENDANCES as readonly unknown[]).includes(attendance)) {
    problem(problems, at(path, 'attendance'), attendance === undefined ? 'required' : 'value');
  }
  const venueName = plainText(problems, at(path, 'venueName'), value.venueName, {
    max: 120,
    optional: true,
  });
  const address = plainText(problems, at(path, 'address'), value.address, {
    max: 300,
    optional: true,
  });
  if (attendance !== 'online' && venueName === null && attendance !== undefined) {
    if ((ATTENDANCES as readonly unknown[]).includes(attendance)) {
      problem(problems, at(path, 'venueName'), 'required');
    }
  }
  const registrationUrl = parseHttpsUrl(
    problems,
    at(path, 'registrationUrl'),
    value.registrationUrl,
  );
  if (problems.length > before || startsAt === null || endsAt === null) return null;
  return {
    startsAt,
    endsAt,
    timeZone: zone,
    attendance: attendance as Attendance,
    venueName,
    address,
    registrationUrl,
    eventStatus: 'scheduled',
    statusMessage: null,
  };
}

export interface EventStatusChange {
  readonly status: EventStatus;
  readonly message: string | null;
}

/** The input of a live status change: a status and, optionally, a short note for readers. */
export function parseEventStatusChange(value: unknown): {
  readonly change: EventStatusChange | null;
  readonly problems: Problems;
} {
  const problems: Problems = [];
  if (!closedObject(problems, '', value, ['status', 'message'])) return { change: null, problems };
  const status = value.status;
  if (!(EVENT_STATUSES as readonly unknown[]).includes(status)) {
    problem(problems, 'status', status === undefined ? 'required' : 'value');
  }
  const message = plainText(problems, 'message', value.message, { max: 300, optional: true });
  if (problems.length > 0) return { change: null, problems };
  return { change: { status: status as EventStatus, message }, problems };
}
