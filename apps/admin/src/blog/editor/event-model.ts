import { instantToLocal } from '../../content/slides/zone-time.ts';

// The event part of a post's content (design A5). The form holds the times as the organiser types
// them (`2026-11-20T18:30`, read in the event's own zone) and sends them that way: the backend reads
// a local time in `timeZone` and stores the instant. What the API adds (`eventStatus`,
// `statusMessage`) is changed by its own route, never by a draft, so it is not sent back.

export const ATTENDANCES = ['offline', 'online', 'mixed'] as const;
export type Attendance = (typeof ATTENDANCES)[number];
export const EVENT_STATUSES = ['scheduled', 'postponed', 'rescheduled', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_LIMITS = { venueName: 120, address: 300, registrationUrl: 500, message: 300 };

export interface EventForm {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly attendance: Attendance;
  readonly venueName: string;
  readonly address: string;
  readonly registrationUrl: string;
}

/** The form of a post that has no event details yet. */
export const blankEvent = (zone: string): EventForm => ({
  startsAt: '',
  endsAt: '',
  timeZone: zone,
  attendance: 'offline',
  venueName: '',
  address: '',
  registrationUrl: '',
});

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The form of the `event` of a version, with its instants shown on the clock of its zone. */
export function eventFormOf(
  event: Readonly<Record<string, unknown>> | null,
  zone: string,
): EventForm | null {
  if (event === null) return null;
  const timeZone = text(event.timeZone) || zone;
  const attendance = (ATTENDANCES as readonly unknown[]).includes(event.attendance)
    ? (event.attendance as Attendance)
    : 'offline';
  return {
    startsAt: instantToLocal(text(event.startsAt), timeZone),
    endsAt: instantToLocal(text(event.endsAt), timeZone),
    timeZone,
    attendance,
    venueName: text(event.venueName),
    address: text(event.address),
    registrationUrl: text(event.registrationUrl),
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** The `event` of a save-draft body. */
export function eventContentOf(form: EventForm | null): Readonly<Record<string, unknown>> | null {
  if (form === null) return null;
  return {
    startsAt: orNull(form.startsAt),
    endsAt: orNull(form.endsAt),
    timeZone: orNull(form.timeZone),
    attendance: form.attendance,
    venueName: orNull(form.venueName),
    address: orNull(form.address),
    registrationUrl: orNull(form.registrationUrl),
  };
}

/** The live status of an event and its note, as the API shows them. */
export function eventStatusOf(event: Readonly<Record<string, unknown>> | null): {
  readonly status: EventStatus;
  readonly message: string;
} {
  const status = (EVENT_STATUSES as readonly unknown[]).includes(event?.eventStatus)
    ? (event?.eventStatus as EventStatus)
    : 'scheduled';
  return { status, message: text(event?.statusMessage) };
}
