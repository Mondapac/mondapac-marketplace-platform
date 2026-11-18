// The first instant of a calendar day on the clock of an IANA zone (ADR-0005).

export const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const WALL_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of an instant in a zone, as the UTC milliseconds of the same numbers. */
function wallMs(ms: number, zone: string): number {
  let format = WALL_FORMATS.get(zone);
  if (format === undefined) {
    // Machine reading, not display: Latin digits and a 24-hour clock whatever the Market locale.
    format = new Intl.DateTimeFormat('en-US', {
      numberingSystem: 'latn',
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    WALL_FORMATS.set(zone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms))) {
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

/**
 * The first instant of a calendar day (yyyy-mm-dd) on the clock of an IANA zone, as an ISO
 * instant; `plus` days later for an exclusive end. Null for a value that is not a real day or a
 * zone this runtime does not know. Where clocks skip midnight, the day starts when they resume.
 */
export function startOfDay(day: string, zone: string, plus = 0): string | null {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = match.slice(1).map(Number) as [number, number, number];
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  const midnight = Date.UTC(year, month - 1, date + plus);
  try {
    // The offsets in force a day either side; the earliest instant at or after local midnight.
    const starts = [midnight - 86_400_000, midnight + 86_400_000]
      .map((probe) => midnight - (wallMs(probe, zone) - probe))
      .filter((ms) => wallMs(ms, zone) >= midnight)
      .sort((a, b) => a - b);
    const start = starts[0];
    return start === undefined ? null : new Date(start).toISOString();
  } catch {
    return null;
  }
}
