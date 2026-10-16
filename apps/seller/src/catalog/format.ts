import { dateFormat } from '../shared/intl.ts';
import { resolveZone } from '../price/zone-time.ts';

/** The zone's short name at that instant in the Market locale ("AEST", "GMT+13"), "UTC" for UTC. */
function zoneLabel(date: Date, locale: string, timeZone: string): string {
  const parts = dateFormat(locale, { timeZoneName: 'short', timeZone }).formatToParts(date);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
}

/**
 * An instant from the API shown in the seller's zone and labelled with the zone's short name
 * ("9 Oct 2026, 11:30 pm AEST"). With no zone, or one this runtime does not know, it is UTC and
 * labelled so.
 */
export function formatInstant(iso: string | null, locale: string, zone?: string | null): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const timeZone = resolveZone(zone);
  const text = dateFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    date,
  );
  return `${text} ${zoneLabel(date, locale, timeZone)}`;
}

/** A compact instant in the seller's zone for a table cell ("14 Oct, 3:30 am"); the year only when not this one. */
export function shortInstant(iso: string, locale: string, zone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const timeZone = resolveZone(zone);
  const yearIn = (instant: Date) =>
    dateFormat('en', { year: 'numeric', numberingSystem: 'latn', timeZone }).format(instant);
  const sameYear = yearIn(date) === yearIn(new Date());
  return dateFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
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
