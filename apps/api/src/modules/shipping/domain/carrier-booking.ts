import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { FleetCode, FleetDeliveryStatus } from './fleet';

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

export interface CarrierBooking {
  readonly id: Id<'CarrierBooking'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderId: Id<'Order'>;
  readonly sellerId: Id<'Seller'>;
  /** The fleet that booked it. */
  readonly fleet: FleetCode;
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
 * A fleet's common status as marketplace progress: pending and assigned are still `booked`;
 * picked up is shipped; delivered is delivered; failed and returned are an exception (an admin
 * follows up); cancelled is cancelled. Every adapter maps its own words to the common status
 * first (`toFleetStatus`), so nothing here knows a fleet.
 */
export function progressOfFleetStatus(status: FleetDeliveryStatus): CarrierProgress {
  switch (status) {
    case 'pending':
    case 'assigned':
      return 'booked';
    case 'picked_up':
      return 'picked-up';
    case 'delivered':
      return 'delivered';
    case 'failed':
    case 'returned':
      return 'exception';
    case 'cancelled':
      return 'cancelled';
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

/** A booking the carrier has just confirmed, at version 1, `booked`. */
export function newBooking(input: {
  readonly id: Id<'CarrierBooking'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderId: Id<'Order'>;
  readonly sellerId: Id<'Seller'>;
  readonly fleet: FleetCode;
  readonly carrierReference: string;
  readonly carrierStatus: string;
  readonly now: Temporal.Instant;
}): CarrierBooking {
  return {
    id: input.id,
    sellerOrderId: input.sellerOrderId,
    orderId: input.orderId,
    sellerId: input.sellerId,
    fleet: input.fleet,
    carrierReference: input.carrierReference,
    progress: 'booked',
    carrierStatus: input.carrierStatus,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
