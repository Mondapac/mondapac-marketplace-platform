import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { CarrierProgress } from './carrier-booking';
import type { FleetCode } from './fleet';

// Where a seller order's real-time carrier delivery stands, for an admin list (the Shipments
// list's carrier progress column). Pure rules only. The read takes five columns of a booking and
// never the carrier reference or the tracking link: a fleet's tracking page shows the drop-off
// and the courier, and the reference is a lookup key at the fleet.

/** The columns the progress read selects from `shipping.carrier_bookings`, and nothing else. */
export interface CarrierProgressRecord {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly fleet: FleetCode;
  readonly progress: CarrierProgress;
  readonly carrierStatus: string;
  readonly updatedAt: Temporal.Instant;
  readonly podRecordedAt: Temporal.Instant | null;
}

/** What shipping answers about one seller order's carrier delivery. */
export interface CarrierProgressView {
  /** The fleet that holds the booking (it may be a fallback, not the fleet quoted at checkout). */
  readonly fleet: string;
  readonly progress: CarrierProgress;
  /**
   * The carrier's last raw status code, for an admin; null when the stored code is not of the
   * shape {@link SHOWN_CARRIER_STATUS} (it is then never shown or exported).
   */
  readonly carrierStatus: string | null;
  /**
   * When the PLATFORM recorded the last change of progress or carrier status (a webhook or a
   * poll it took), not the carrier's own event time. A poll that changes nothing leaves it.
   */
  readonly updatedAt: Temporal.Instant;
  /** Whether the fleet reported proof of delivery (the photo, signature or name is never kept). */
  readonly proofOfDelivery: boolean;
}

/**
 * The only carrier status shape shown to an admin. The database allows any printable ASCII
 * code; this keeps markup- or formula-shaped text (`<`, `>`, `=`, `+`, quotes, spaces) out of
 * every screen and export even if a future fleet adapter stores one (Hassan H3).
 */
export const SHOWN_CARRIER_STATUS = /^[A-Za-z0-9_.-]{1,60}$/;

export function shownCarrierStatus(value: string): string | null {
  return SHOWN_CARRIER_STATUS.test(value) ? value : null;
}

export function carrierProgressView(record: CarrierProgressRecord): CarrierProgressView {
  return {
    fleet: record.fleet,
    progress: record.progress,
    carrierStatus: shownCarrierStatus(record.carrierStatus),
    updatedAt: record.updatedAt,
    proofOfDelivery: record.podRecordedAt !== null,
  };
}
