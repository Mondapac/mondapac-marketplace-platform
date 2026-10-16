import { dateFormat } from '../shared/intl.ts';
import { formatInZone, resolveZone, zoneName } from '../price/zone-time.ts';

/**
 * An instant from the API shown in the seller's zone and labelled with the zone's short name
 * ("9 Oct 2026, 11:30 pm AEST"). With no zone, or one this runtime does not know, it is UTC and
 * labelled so.
 */
export function formatInstant(iso: string | null, locale: string, zone?: string | null): string {
  return formatInZone(iso, resolveZone(zone), locale);
}

/** A compact instant in the seller's zone for a table cell ("14 Oct, 3:30 am AEST"); the year only when not this one. */
export function shortInstant(iso: string, locale: string, zone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const timeZone = resolveZone(zone);
  const yearIn = (instant: Date) =>
    dateFormat('en', { year: 'numeric', numberingSystem: 'latn', timeZone }).format(instant);
  const sameYear = yearIn(date) === yearIn(new Date());
  const text = dateFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
  return `${text} ${zoneName(date, locale, timeZone)}`;
}

/** A status or code from the API as a translation key suffix; unknown values map to `unknown`. */
export function known(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : 'unknown';
}

export const PRODUCT_STATUSES = [
  'draft',
  'unpublished',
  'published',
  'matched',
  'retired',
] as const;
export const OFFER_STATUSES = [
  'draft',
  'pending-first-publish',
  'changes-needed',
  'published',
] as const;

/** A code from the API as readable text when no translation names it (`dry-goods` to `Dry goods`). */
export function readable(code: string): string {
  const text = code.replace(/[-_]+/g, ' ').trim();
  return text === '' ? code : text.charAt(0).toUpperCase() + text.slice(1);
}
