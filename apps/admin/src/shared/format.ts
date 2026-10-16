import { dateFormat } from './intl.ts';

/** An instant from the API in UTC, labelled so; a bad value shows as a dash. */
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
export function shortInstant(iso: string | null, locale: string): string {
  if (iso === null) return '-';
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
