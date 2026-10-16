import { dateFormat } from '../shared/intl.ts';

/** The zone times fall back to when the seller's own zone could not be read. */
export const FALLBACK_ZONE = 'UTC';

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    // Machine reading of the parts, not display: the root locale with Latin digits, so no
    // Market language or numbering system can change what is parsed.
    formatter = new Intl.DateTimeFormat('und', {
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
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The wall clock of an instant in a zone, as the number of ms since the epoch read as UTC. */
function wallMs(ms: number, zone: string): number {
  const parts = partsFormatter(zone).formatToParts(new Date(ms));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
}

/** Whether the zone is one this runtime knows. */
export function isKnownZone(zone: string): boolean {
  try {
    partsFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * A `datetime-local` value ("2026-10-20T01:00") read as a wall-clock time in an IANA zone and
 * answered as a UTC instant ("2026-10-19T14:00:00Z"), or null when it is not a time or the zone
 * has no such time (the hour skipped when clocks go forward). A time that happens twice when
 * clocks go back is read as the first one.
 */
export function instantOfZoned(text: string, zone: string): string | null {
  const match = WALL.exec(text.trim());
  if (match === null || !isKnownZone(zone)) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(match[i] ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(wall)) return null;
  // The offset in force around the wall time, tried before and after it, earliest instant first.
  const candidates = new Set<number>();
  for (const probe of [wall - 86_400_000, wall + 86_400_000]) {
    const offset = wallMs(probe, zone) - probe;
    candidates.add(wall - offset);
  }
  const hits = [...candidates].filter((ms) => wallMs(ms, zone) === wall).sort((a, b) => a - b);
  const first = hits[0];
  return first === undefined ? null : new Date(first).toISOString().replace('.000Z', 'Z');
}

/** An instant from the API shown in a zone and labelled with the zone's id. */
export function formatInZone(iso: string | null, zone: string, locale: string): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || !isKnownZone(zone)) return '-';
  const formatter = dateFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone });
  return `${formatter.format(date)} ${zone}`;
}
