import type { Id, Temporal } from '@mondapac/shared-kernel';

// A seller order handed to a real-time carrier (SHP-02/03, Mondapac Drive first): the
// `real_time_delivery` FulfillmentStrategy. Pure rules only; the carrier's wire format lives in
// the adapter. A booking never holds a name, an address or a phone number: the carrier has them.

/**
 * Where a carrier delivery stands, as the marketplace sees it. `booked`: the carrier holds it
 * (scheduled, dispatching, assigned, at pickup);
 * `picked-up`: on the way (the seller order is shipped); `delivered`: handed over (the seller
 * order is delivered); `exception`: failed or returned, an admin follows up; `cancelled`: the
 * carrier will not deliver it.
 */
export const CARRIER_PROGRESS = [
  'booked',
  'picked-up',
  'delivered',
  'exception',
  'cancelled',
] as const;
export type CarrierProgress = (typeof CARRIER_PROGRESS)[number];

/** The carrier code of Mondapac Drive: the only real-time carrier today. */
export const MONDAPAC_DRIVE = 'mondapac-drive';

export interface CarrierBooking {
  readonly id: Id<'CarrierBooking'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderId: Id<'Order'>;
  readonly sellerId: Id<'Seller'>;
  readonly carrier: typeof MONDAPAC_DRIVE;
  /** The carrier's own id of the delivery. */
  readonly carrierReference: string;
  readonly progress: CarrierProgress;
  /** The carrier's last status code as received (`PICKED_UP`), for an admin. */
  readonly carrierStatus: string;
  /** Raised by each change; the version of the event that announces it. */
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/** The order in which progress may move; the three final states share the last rank. */
const RANK: Readonly<Record<CarrierProgress, number>> = {
  booked: 0,
  'picked-up': 1,
  delivered: 2,
  exception: 2,
  cancelled: 2,
};

export const isFinalProgress = (progress: CarrierProgress): boolean => RANK[progress] === 2;

/**
 * Drive's delivery statuses as marketplace progress (handoff 09): PICKED_UP is shipped,
 * DELIVERED is delivered, DELIVERY_FAILED and RETURNED are an exception. Every status before
 * pickup is `booked`; AT_DROPOFF is still on the way; RETURNING is already an exception. An
 * unknown status is null and changes nothing.
 */
export function progressOfDriveStatus(status: string): CarrierProgress | null {
  switch (status) {
    case 'SCHEDULED':
    case 'DISPATCHING':
    case 'ASSIGNED':
    case 'AT_PICKUP':
      return 'booked';
    case 'PICKED_UP':
    case 'AT_DROPOFF':
      return 'picked-up';
    case 'DELIVERED':
      return 'delivered';
    case 'DELIVERY_FAILED':
    case 'RETURNING':
    case 'RETURNED':
      return 'exception';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * The booking after the carrier reported `progress` (and its raw status): null when nothing
 * changes. Progress only moves forward, because webhooks arrive at least once and in no order: an
 * older status after a newer one is ignored, and a final state is never left. A cancellation
 * after pickup is not possible at the carrier, so it is ignored too. A repeat of the same status
 * changes nothing.
 */
export function advanceBooking(
  booking: CarrierBooking,
  report: { readonly progress: CarrierProgress; readonly carrierStatus: string },
  now: Temporal.Instant,
): CarrierBooking | null {
  const from = booking.progress;
  const to = report.progress;
  if (isFinalProgress(from)) return null;
  if (RANK[to] < RANK[from]) return null;
  if (to === 'cancelled' && RANK[from] >= RANK['picked-up']) return null;
  if (to === from && report.carrierStatus === booking.carrierStatus) return null;
  return {
    ...booking,
    progress: to,
    carrierStatus: report.carrierStatus,
    version: booking.version + 1,
    updatedAt: now,
  };
}

/**
 * A booking the carrier has just confirmed, at version 1. A status the marketplace does not know
 * yet counts as `booked`.
 */
export function newBooking(input: {
  readonly id: Id<'CarrierBooking'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderId: Id<'Order'>;
  readonly sellerId: Id<'Seller'>;
  readonly carrierReference: string;
  readonly carrierStatus: string;
  readonly now: Temporal.Instant;
}): CarrierBooking {
  return {
    id: input.id,
    sellerOrderId: input.sellerOrderId,
    orderId: input.orderId,
    sellerId: input.sellerId,
    carrier: MONDAPAC_DRIVE,
    carrierReference: input.carrierReference,
    progress: progressOfDriveStatus(input.carrierStatus) ?? 'booked',
    carrierStatus: input.carrierStatus,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
