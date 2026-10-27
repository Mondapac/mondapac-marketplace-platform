// Wall-clock times in an IANA zone, for the datetime-local fields of "Where and when". The API
// stores instants (ADR-0005); the person types the time on the clock of the Market's zone.

const FORMATS = new Map<string, Intl.DateTimeFormat>();

function formatOf(zone: string): Intl.DateTimeFormat {
  const found = FORMATS.get(zone);
  if (found !== undefined) return found;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  FORMATS.set(zone, made);
  return made;
}

/** The wall clock of an instant in a zone, as the UTC milliseconds of the same numbers. */
function wallClock(ms: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatOf(zone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `2026-10-27T09:30` for a datetime-local field, or '' for an instant that is not a date. */
export function instantToLocal(iso: string, zone: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const wall = new Date(wallClock(ms, zone));
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

/** The instant (ISO, UTC) of a datetime-local value read on the clock of `zone`, or null. */
export function localToInstant(local: string, zone: string): string | null {
  const match = LOCAL.exec(local);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(wanted).getUTCMonth() !== month - 1) return null;
  // The zone's offset at the guess; once more at the corrected instant, for a daylight-saving edge.
  let ms = wanted - (wallClock(wanted, zone) - wanted);
  ms = wanted - (wallClock(ms, zone) - ms);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
