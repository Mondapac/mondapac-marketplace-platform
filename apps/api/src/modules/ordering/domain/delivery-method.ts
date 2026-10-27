import { Temporal } from '@mondapac/shared-kernel';

// The buyer's delivery method per seller order (delivery models, package 1). The buyer picks it
// at checkout; the seller has no say in the method or the provider and never delivers. The
// platform picks the provider per order from the method and the fleet status. Instants are UTC
// (ADR-0005); the window is compared as instants only.

/**
 * `pickup`: in person. `instant`: under 2 hours. `same_day`: before a cut-off. `scheduled`: a
 * future window the buyer chose.
 */
export const DELIVERY_METHODS = ['pickup', 'instant', 'same_day', 'scheduled'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/** The method of orders that name none (also the backfill of orders placed before this field). */
export const DEFAULT_DELIVERY_METHOD: DeliveryMethod = 'instant';

/** The window of a scheduled delivery: UTC instants, `end` after `start`. */
export interface DeliveryWindow {
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

/** One seller order's method with its window (`scheduled` only; null for every other method). */
export interface DeliveryChoice {
  readonly method: DeliveryMethod;
  readonly window: DeliveryWindow | null;
}

/** When a carrier is booked for a method: at payment, when the seller marks ready, or never. */
export type BookingMoment = 'payment' | 'ready' | 'never';

/**
 * Scheduled is booked at payment for the chosen window; instant and same day are booked when the
 * seller marks the order ready; a pickup never books a carrier.
 */
export function bookingMomentOf(method: DeliveryMethod): BookingMoment {
  switch (method) {
    case 'scheduled':
      return 'payment';
    case 'instant':
    case 'same_day':
      return 'ready';
    case 'pickup':
      return 'never';
  }
}

const instantOf = (value: unknown): Temporal.Instant | null => {
  if (typeof value !== 'string') return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
};

type Field = { path: string; code: string };

/**
 * Parses the `deliveryMethods` of a checkout: absent, or an object of seller id to
 * `{ method, windowStart?, windowEnd? }`. `scheduled` needs both instants, the start after
 * `now` and the end after the start; every other method takes no window. An unknown method,
 * a missing or malformed window and an extra key are refused whole, naming the path. Seller ids
 * are checked by the caller against the order's sellers.
 */
export function parseDeliveryChoices(
  value: unknown,
  now: Temporal.Instant,
): { ok: true; choices: ReadonlyMap<string, DeliveryChoice> } | { ok: false; fields: Field[] } {
  if (value === undefined || value === null) return { ok: true, choices: new Map() };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, fields: [{ path: 'deliveryMethods', code: 'type' }] };
  }
  const entries = Object.entries(value);
  if (entries.length > 50)
    return { ok: false, fields: [{ path: 'deliveryMethods', code: 'size' }] };
  const choices = new Map<string, DeliveryChoice>();
  const fields: Field[] = [];
  for (const [sellerId, raw] of entries) {
    const path = `deliveryMethods.${Array.from(sellerId).slice(0, 40).join('')}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fields.push({ path, code: 'type' });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const extra = Object.keys(entry).find(
      (key) => key !== 'method' && key !== 'windowStart' && key !== 'windowEnd',
    );
    if (extra !== undefined) {
      fields.push({ path: `${path}.field`, code: 'unknown-field' });
      continue;
    }
    const method = DELIVERY_METHODS.find((candidate) => candidate === entry.method);
    if (method === undefined) {
      fields.push({ path: `${path}.method`, code: 'value' });
      continue;
    }
    if (method !== 'scheduled') {
      if (entry.windowStart !== undefined || entry.windowEnd !== undefined) {
        fields.push({ path: `${path}.window`, code: 'not-allowed' });
      } else choices.set(sellerId, { method, window: null });
      continue;
    }
    const start = instantOf(entry.windowStart);
    const end = instantOf(entry.windowEnd);
    if (start === null) fields.push({ path: `${path}.windowStart`, code: 'format' });
    if (end === null) fields.push({ path: `${path}.windowEnd`, code: 'format' });
    if (start === null || end === null) continue;
    if (Temporal.Instant.compare(start, now) <= 0) {
      fields.push({ path: `${path}.windowStart`, code: 'past' });
    } else if (Temporal.Instant.compare(end, start) <= 0) {
      fields.push({ path: `${path}.windowEnd`, code: 'range' });
    } else choices.set(sellerId, { method, window: { start, end } });
  }
  return fields.length > 0 ? { ok: false, fields } : { ok: true, choices };
}

/**
 * The platform-attention state of a seller order: why an admin must look at it. `no-carrier`:
 * no fleet can carry it; `carrier-unknown`: a fleet that cannot dedupe went quiet on the booking,
 * so it may exist; `cancel-unknown`: such a fleet refused a cancel, which does not say whether the
 * delivery is still booked.
 */
export type DeliveryAttention = 'no-carrier' | 'carrier-unknown' | 'cancel-unknown';
