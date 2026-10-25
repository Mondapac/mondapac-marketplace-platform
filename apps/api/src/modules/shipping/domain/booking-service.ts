import { Temporal } from '@mondapac/shared-kernel';

// How fast a carrier trip must be done, as the buyer chose it and ordering passes it on
// (delivery models). `pickup` never reaches shipping: nobody books a carrier for a pickup.
// Instants are UTC (ADR-0005); the window is compared as instants, never as wall-clock text.

/** The delivery methods a carrier can serve. */
export const CARRIER_METHODS = ['instant', 'same_day', 'scheduled'] as const;
export type CarrierMethod = (typeof CARRIER_METHODS)[number];

/** A booking's service level: `scheduled` carries the buyer's chosen window, the others none. */
export type BookingService =
  | { readonly method: 'instant' | 'same_day'; readonly window: null }
  | {
      readonly method: 'scheduled';
      readonly window: { readonly start: Temporal.Instant; readonly end: Temporal.Instant };
    };

/** The carrier mode of a method: only a scheduled trip is booked for a window. */
export const carrierModeOf = (service: BookingService): 'on_demand' | 'scheduled' =>
  service.method === 'scheduled' ? 'scheduled' : 'on_demand';

const instantOf = (value: unknown): Temporal.Instant | null => {
  if (typeof value !== 'string') return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
};

/**
 * The service of a booking request from another module, checked. `instant` and `same_day` take
 * no window; `scheduled` needs a window whose end is after its start (both ISO instants).
 */
export function parseBookingService(
  input: unknown,
):
  | { readonly ok: true; readonly service: BookingService }
  | { readonly ok: false; readonly fields: readonly { path: string; code: string }[] } {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const method = CARRIER_METHODS.find((candidate) => candidate === value.method);
  if (method === undefined)
    return { ok: false, fields: [{ path: 'service.method', code: 'value' }] };
  if (method !== 'scheduled') {
    return value.window === null || value.window === undefined
      ? { ok: true, service: { method, window: null } }
      : { ok: false, fields: [{ path: 'service.window', code: 'not-allowed' }] };
  }
  const window = (
    typeof value.window === 'object' && value.window !== null ? value.window : {}
  ) as Record<string, unknown>;
  const start = instantOf(window.start);
  const end = instantOf(window.end);
  const fields = [
    ...(start === null ? [{ path: 'service.window.start', code: 'format' }] : []),
    ...(end === null ? [{ path: 'service.window.end', code: 'format' }] : []),
  ];
  if (start === null || end === null) return { ok: false, fields };
  if (Temporal.Instant.compare(end, start) <= 0) {
    return { ok: false, fields: [{ path: 'service.window', code: 'range' }] };
  }
  return { ok: true, service: { method, window: { start, end } } };
}
