const INSTANT = new Intl.DateTimeFormat('en-AU', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** An instant from the API, shown in UTC and labelled so (the seller's zone is not in the session). */
export function formatInstant(iso: string | null): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : `${INSTANT.format(date)} UTC`;
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
