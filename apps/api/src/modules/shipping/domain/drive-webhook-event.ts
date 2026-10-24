// The body of a Mondapac Drive delivery webhook (Drive's docs/notifications/webhooks.md, its
// notifications package; also docs/modules/shipping/carrier-mondapac-drive.md here):
//
//   { "id": "<event UUIDv7>", "type": "delivery.status-changed", "occurredAt": "<ISO instant>",
//     "marketId": "AU",
//     "data": { "deliveryId": "<uuid>", "externalReference": "<seller order uuid>",
//               "status": "PICKED_UP", "previousStatus": "AT_PICKUP", "reason": "<code>" } }
//
// The three types (`delivery.booked`, `delivery.status-changed`, `delivery.cancelled`) all carry
// the delivery's status after the change, which is all the marketplace reads. Pure: the signature
// is checked on the raw bytes before this runs. Nothing else of the body is read.

/** The webhook types that carry a delivery status. */
export const DRIVE_DELIVERY_EVENTS: readonly string[] = [
  'delivery.booked',
  'delivery.status-changed',
  'delivery.cancelled',
];

export interface DriveStatusChanged {
  readonly eventId: string;
  readonly marketId: string;
  readonly deliveryId: string;
  readonly externalReference: string;
  readonly status: string;
}

export type ParsedDriveWebhook =
  | { readonly kind: 'delivery'; readonly event: DriveStatusChanged }
  /** Another event type: acknowledged and dropped. */
  | { readonly kind: 'other' }
  | { readonly kind: 'invalid' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKET = /^[A-Z][A-Z0-9_]{1,7}$/;
const STATUS = /^[A-Z][A-Z_]{1,39}$/;
const TYPE = /^[a-z][a-z0-9.-]{1,99}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The body as JSON: strict UTF-8, one object; null otherwise. */
function json(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Reads a signed webhook body. Ids must be lower-case UUIDs; the status an upper-case code. */
export function parseDriveWebhook(payload: Uint8Array): ParsedDriveWebhook {
  const body = json(payload);
  if (body === null || typeof body.id !== 'string' || !UUID.test(body.id)) {
    return { kind: 'invalid' };
  }
  if (typeof body.type !== 'string' || !TYPE.test(body.type)) return { kind: 'invalid' };
  if (!DRIVE_DELIVERY_EVENTS.includes(body.type)) return { kind: 'other' };
  const data = body.data;
  if (
    typeof body.marketId !== 'string' ||
    !MARKET.test(body.marketId) ||
    !isObject(data) ||
    typeof data.deliveryId !== 'string' ||
    !UUID.test(data.deliveryId) ||
    typeof data.externalReference !== 'string' ||
    !UUID.test(data.externalReference) ||
    typeof data.status !== 'string' ||
    !STATUS.test(data.status)
  ) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'delivery',
    event: {
      eventId: body.id,
      marketId: body.marketId,
      deliveryId: data.deliveryId,
      externalReference: data.externalReference,
      status: data.status,
    },
  };
}
