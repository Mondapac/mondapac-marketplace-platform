import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

/** Whether an order placed before the cut-off is delivered the same day or the next day. */
export const DELIVERY_DAYS = ['same-day', 'next-day'] as const;
export type DeliveryDay = (typeof DELIVERY_DAYS)[number];

/**
 * The delivery terms a seller shows on the store page (package e): the day, the window and the
 * daily order cut-off. Times are minutes since local midnight in the seller's own zone (ADR-0005),
 * in half-hour steps. The cut-off is a clock time, not an instant, so no zone arithmetic happens
 * here: the buyer site shows the seller's clock.
 */
export interface DeliveryTerms {
  readonly day: DeliveryDay;
  /** The window opens, 0 to 1410. */
  readonly fromMinute: number;
  /** The window closes, 30 to 1440, after it opens. */
  readonly toMinute: number;
  /** Orders placed before this are on the day above, 0 to 1410. */
  readonly cutoffMinute: number;
}

/** The terms as the HTTP edge sends and reads them: `HH:MM` clock strings. */
export interface DeliveryTermsText {
  readonly day: DeliveryDay;
  readonly from: string;
  readonly to: string;
  readonly cutoff: string;
}

export const DELIVERY_STEP_MINUTES = 30;
const MINUTES_PER_DAY = 1440;
const CLOCK = /^(?:(?:[01][0-9]|2[0-3]):(?:00|30)|24:00)$/u;

/**
 * `delivery.day`: not `same-day` or `next-day`. `delivery.window`: a time that is not a half hour,
 * or a window that does not open before it closes. `delivery.cutoff`: a cut-off that is not a half
 * hour, or a same-day cut-off at or after the window closes (a seller cannot take an order for a
 * window that is already over).
 */
export type DeliveryTermsRefusal =
  | { readonly code: 'delivery.day' }
  | { readonly code: 'delivery.window' }
  | { readonly code: 'delivery.cutoff' };

/** `HH:MM` to minutes since midnight; `24:00` only where `allowEndOfDay` (the window's end). */
function minutesOf(value: unknown, allowEndOfDay: boolean): number | null {
  if (typeof value !== 'string') return null;
  const match = CLOCK.exec(value);
  if (match === null) return null;
  const [hours = '', minutes = ''] = match[0].split(':');
  const total = Number(hours) * 60 + Number(minutes);
  return total === MINUTES_PER_DAY && !allowEndOfDay ? null : total;
}

/** Minutes since midnight to `HH:MM`; 1440 is `24:00`. */
export function clockOf(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** The text form of stored terms, for the HTTP edge. */
export function termsTextOf(terms: DeliveryTerms): DeliveryTermsText {
  return {
    day: terms.day,
    from: clockOf(terms.fromMinute),
    to: clockOf(terms.toMinute),
    cutoff: clockOf(terms.cutoffMinute),
  };
}

/** Rebuilds stored terms from its four columns; null unless all four are set and valid. */
export function termsOfStored(row: {
  readonly day: string | null;
  readonly fromMinute: number | null;
  readonly toMinute: number | null;
  readonly cutoffMinute: number | null;
}): DeliveryTerms | null {
  const { day, fromMinute, toMinute, cutoffMinute } = row;
  if (day === null || fromMinute === null || toMinute === null || cutoffMinute === null) {
    return null;
  }
  if (day !== 'same-day' && day !== 'next-day') return null;
  return { day, fromMinute, toMinute, cutoffMinute };
}

/**
 * Parses the `delivery` of a request: `null` (or absent) clears the terms; otherwise `{ day, from,
 * to, cutoff }`. Refused with a code, never an echo of the value.
 */
export function parseDeliveryTerms(
  value: unknown,
): Result<DeliveryTerms | null, DeliveryTermsRefusal> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== 'object' || Array.isArray(value)) return err({ code: 'delivery.day' });
  const { day, from, to, cutoff } = value as Record<string, unknown>;
  if (day !== 'same-day' && day !== 'next-day') return err({ code: 'delivery.day' });
  const fromMinute = minutesOf(from, false);
  const toMinute = minutesOf(to, true);
  if (fromMinute === null || toMinute === null || fromMinute >= toMinute) {
    return err({ code: 'delivery.window' });
  }
  const cutoffMinute = minutesOf(cutoff, false);
  if (cutoffMinute === null || (day === 'same-day' && cutoffMinute >= toMinute)) {
    return err({ code: 'delivery.cutoff' });
  }
  return ok({ day, fromMinute, toMinute, cutoffMinute });
}

export const sameTerms = (a: DeliveryTerms | null, b: DeliveryTerms | null): boolean =>
  a === null || b === null
    ? a === b
    : a.day === b.day &&
      a.fromMinute === b.fromMinute &&
      a.toMinute === b.toMinute &&
      a.cutoffMinute === b.cutoffMinute;
