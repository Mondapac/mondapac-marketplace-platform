import { shortDateInZone } from '../shared/format.ts';

const DAY_MS = 86_400_000;
/** Within this many days of the deadline the date is flagged as soon. */
export const SOON_DAYS = 3;

export type EvidenceDue =
  | { readonly kind: 'overdue'; readonly date: string }
  | { readonly kind: 'soon'; readonly days: number; readonly date: string }
  | { readonly kind: 'later'; readonly date: string };

/**
 * The evidence deadline of a case: always the absolute date in the admin's zone; "soon" when at
 * most three days are left (counted up, so a deadline later today is 1 day), "overdue" once it is
 * past. `now` is passed in so a test fixes the clock.
 */
export function evidenceDue(
  iso: string,
  now: number,
  locale: string,
  zone: string,
): EvidenceDue | null {
  const due = new Date(iso).getTime();
  if (Number.isNaN(due)) return null;
  const date = shortDateInZone(iso, locale, zone);
  if (due < now) return { kind: 'overdue', date };
  const days = Math.ceil((due - now) / DAY_MS);
  return days <= SOON_DAYS ? { kind: 'soon', days, date } : { kind: 'later', date };
}

/** Stripe's reason code as readable text ("product_not_received" -> "Product not received"). */
export function reasonText(reason: string): string {
  const words = reason.replace(/[_-]+/g, ' ').trim();
  return words === '' ? '-' : words.charAt(0).toUpperCase() + words.slice(1);
}
