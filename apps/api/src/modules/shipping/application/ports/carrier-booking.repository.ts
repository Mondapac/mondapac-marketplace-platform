import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CarrierBooking } from '../../domain/carrier-booking';

/**
 * The carrier bookings of one Market (`shipping.carrier_bookings`) and the carrier webhook events
 * already taken (`shipping.carrier_events`). Every method runs inside the caller's unit of work
 * and is scoped by the Market.
 */
export interface CarrierBookingRepository {
  findBySellerOrder(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
  ): Promise<CarrierBooking | null>;

  /** Stores a new booking; `exists` when the seller order already has one (nothing changes). */
  insert(market: MarketContext, booking: CarrierBooking): Promise<'inserted' | 'exists'>;

  /** Stores a change when the stored version is still `expectedVersion`. */
  save(
    market: MarketContext,
    booking: CarrierBooking,
    expectedVersion: number,
  ): Promise<'saved' | 'conflict'>;

  /** Takes a webhook event once by its id: `duplicate` when it was taken before. */
  recordEvent(
    market: MarketContext,
    event: {
      readonly eventId: string;
      readonly carrier: string;
      readonly receivedAt: Temporal.Instant;
    },
  ): Promise<'recorded' | 'duplicate'>;
}

export const CARRIER_BOOKING_REPOSITORY = Symbol('CARRIER_BOOKING_REPOSITORY');
