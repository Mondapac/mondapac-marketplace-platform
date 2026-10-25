// Answers of the seller store-settings routes (apps/api store-settings.controller.ts), as far as
// the delivery tab uses them. The minimum order in the same answer is not read here.

export const STORE_SETTINGS_EDIT_PERMISSION = 'sellers.store-settings.edit';

export const DELIVERY_DAYS = ['same-day', 'next-day'] as const;
export type DeliveryDay = (typeof DELIVERY_DAYS)[number];

/** The terms as the API sends and takes them: half-hour clock times in the seller's own zone. */
export interface DeliveryTerms {
  readonly day: DeliveryDay;
  readonly from: string;
  readonly to: string;
  readonly cutoff: string;
}

export interface DeliverySettingsView {
  /** The version the screen read; the save sends it back. */
  readonly version: number;
  /** null: no terms set, so the store page shows no delivery line. */
  readonly delivery: DeliveryTerms | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `00:00` to `23:30`, the half hours of a day. */
export const CLOCK_TIMES: readonly string[] = Array.from(
  { length: 48 },
  (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 === 0 ? '00' : '30'}`,
);

/** The times a window may close at: after the first half hour, up to the end of the day. */
export const CLOSE_TIMES: readonly string[] = [...CLOCK_TIMES.slice(1), '24:00'];

const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** What the API refuses, found before the request: the form says so next to the field. */
export function problemsOf(terms: DeliveryTerms): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  if (minutes(terms.from) >= minutes(terms.to)) found['delivery.to'] = 'delivery.validation.window';
  if (terms.day === 'same-day' && minutes(terms.cutoff) >= minutes(terms.to)) {
    found['delivery.cutoff'] = 'delivery.validation.cutoff-same-day';
  }
  return found;
}
