import { dateFormat } from '../shared/intl.ts';

/** An instant from the API, shown in UTC and labelled so (the seller's zone is not in the session). */
export function formatInstant(iso: string | null, locale: string): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const text = dateFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
  return `${text} UTC`;
}

/** A compact UTC instant for a table cell ("14 Oct, 3:30 am"); the year only when not this one. */
export function shortInstant(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return dateFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
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
