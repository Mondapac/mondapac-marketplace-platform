const INSTANT = new Intl.DateTimeFormat('en-AU', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** An instant from the API in UTC, labelled so; a bad value shows as a dash. */
export function formatInstant(iso: string | null): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : `${INSTANT.format(date)} UTC`;
}

/** A value from the API as a translation key suffix; anything unlisted becomes `unknown`. */
export function known(value: string | null, allowed: readonly string[]): string {
  return value !== null && allowed.includes(value) ? value : 'unknown';
}

const DAY_TIME = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});
const DAY_TIME_YEAR = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

/** A compact UTC instant for a table cell ("14 Oct, 3:30 am"); the year only when not this one. */
export function shortInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return (sameYear ? DAY_TIME : DAY_TIME_YEAR).format(date);
}

/** A service area code ("greater-brisbane") as a name ("Greater Brisbane"). */
export function areaName(code: string | null): string {
  if (code === null || code.trim() === '') return '-';
  return code
    .split(/[-_]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Street lines first, then locality, region and postcode on one line; the Market decides which
// keys exist, so a key outside these lists is kept, after them, as its own line.
const STREET_KEYS = ['line1', 'line2', 'line3', 'street', 'address_line1', 'address_line2'];
const PLACE_KEYS = [
  'suburb',
  'locality',
  'city',
  'town',
  'state',
  'region',
  'province',
  'postcode',
  'postal_code',
  'postalCode',
  'zip',
];

/** A postal address as display lines ("149 Moggill Road" / "Taringa QLD 4068"). */
export function addressLines(address: Readonly<Record<string, string>> | null): string | null {
  if (address === null) return null;
  const value = (key: string) => address[key]?.trim() ?? '';
  const street = STREET_KEYS.map(value).filter((part) => part !== '');
  const place = PLACE_KEYS.map(value).filter((part) => part !== '');
  const known = new Set([...STREET_KEYS, ...PLACE_KEYS, 'country', 'country_code', 'countryCode']);
  const other = Object.entries(address)
    .filter(([key, part]) => !known.has(key) && part.trim() !== '')
    .map(([, part]) => part.trim());
  const lines = [...street, ...(place.length > 0 ? [place.join(' ')] : []), ...other];
  return lines.length === 0 ? null : lines.join('\n');
}
