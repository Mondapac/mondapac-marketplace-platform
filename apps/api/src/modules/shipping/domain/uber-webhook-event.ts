// The body of an Uber Direct delivery status webhook, read from Uber's public webhook documentation
// (developer.uber.com, Uber Direct "Webhooks"; the field names are NOT yet confirmed against the
// test account, so every alternative Uber has used is accepted and each is checked):
//
//   { "kind": "event.delivery_status"            (or "event_type"),
//     "id": "<event id>"                         (or "event_id"),
//     "delivery_id": "del_...",                  (or data.id, or meta.resource_id)
//     "status": "pickup_complete",               (or data.status, or meta.status)
//     "data": { "id": "del_...", "status": "...", "external_id": "<seller order>",
//               "verification" | "proof_of_delivery": { ... } } }
//
// Pure: the signature is checked on the raw bytes before this runs. Only the event id, the
// delivery id, the status and whether a proof of delivery is present are read. The proof itself
// (a photo, a signature image, a recipient's name) is never read into anything, so it can reach
// no store, log or event.

import type { FleetDeliveryStatus } from './fleet';

/** The webhook kinds that carry a delivery status. */
export const UBER_DELIVERY_EVENTS: readonly string[] = ['event.delivery_status'];

export interface UberStatusChanged {
  /** Uber's event id as sent, for the log-free dedupe key ({@link uberEventKey}). */
  readonly eventId: string;
  readonly deliveryId: string;
  /** Uber's status word as sent, lower case. */
  readonly status: string;
  /** True when the event says a proof of delivery exists; the proof itself is never read. */
  readonly proofOfDelivery: boolean;
}

export type ParsedUberWebhook =
  | { readonly kind: 'delivery'; readonly event: UberStatusChanged }
  /** Another event kind: acknowledged and dropped. */
  | { readonly kind: 'other' }
  | { readonly kind: 'invalid' };

const EVENT_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const DELIVERY_ID = /^[A-Za-z0-9_-]{8,80}$/;
const STATUS = /^[a-z][a-z_]{1,39}$/;
const KIND = /^[a-z][a-z0-9._-]{1,99}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const present = (value: unknown): boolean =>
  isObject(value) ? Object.keys(value).length > 0 : value === true;

/** The body as JSON: strict UTF-8, one object; null otherwise. */
function json(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Reads a signed webhook body. The status is lower case; ids are Uber's tokens. */
export function parseUberWebhook(payload: Uint8Array): ParsedUberWebhook {
  const body = json(payload);
  if (body === null) return { kind: 'invalid' };
  const kind = text(body.kind) ?? text(body.event_type);
  if (kind === undefined || !KIND.test(kind)) return { kind: 'invalid' };
  if (!UBER_DELIVERY_EVENTS.includes(kind)) return { kind: 'other' };
  const data = isObject(body.data) ? body.data : {};
  const meta = isObject(body.meta) ? body.meta : {};
  const eventId = text(body.id) ?? text(body.event_id);
  const deliveryId = text(body.delivery_id) ?? text(data.id) ?? text(meta.resource_id);
  const status = (text(body.status) ?? text(data.status) ?? text(meta.status))?.toLowerCase();
  if (
    eventId === undefined ||
    !EVENT_ID.test(eventId) ||
    deliveryId === undefined ||
    !DELIVERY_ID.test(deliveryId) ||
    status === undefined ||
    !STATUS.test(status)
  ) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'delivery',
    event: {
      eventId,
      deliveryId,
      status,
      proofOfDelivery:
        present(data.proof_of_delivery) ||
        present(data.verification) ||
        present(body.proof_of_delivery),
    },
  };
}

/**
 * Uber's delivery status word (either case) as the common fleet status: the pure `toFleetStatus`
 * of the Uber Direct adapter, which re-exports it. An unknown word is null: it is taken as
 * received and changes nothing.
 */
export function toFleetStatus(raw: string): FleetDeliveryStatus | null {
  switch (raw.toUpperCase()) {
    case 'PENDING':
      return 'pending';
    case 'PICKUP':
      return 'assigned';
    case 'PICKUP_COMPLETE':
    case 'DROPOFF':
      return 'picked_up';
    case 'DELIVERED':
      return 'delivered';
    case 'CANCELED':
      return 'cancelled';
    case 'RETURNED':
      return 'returned';
    default:
      return null;
  }
}
