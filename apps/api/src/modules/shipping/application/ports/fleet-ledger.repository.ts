import type { Id, MarketContext, Money, Temporal } from '@mondapac/shared-kernel';
import type { FleetCode } from '../../domain/fleet';
import type { FleetFeeReason } from '../../domain/fleet-fee';

/** A fee a fleet charged the platform, as stored. */
export interface FleetFeeRecord {
  readonly id: Id<'FleetFee'>;
  readonly fleet: FleetCode;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly reason: FleetFeeReason;
  readonly amount: Money;
  readonly externalRef: string;
  readonly occurredAt: Temporal.Instant;
  readonly recordedAt: Temporal.Instant;
}

/** A booking given to another fleet than the one the buyer was charged for. */
export interface DeliveryFallbackRecord {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly chargedFleet: FleetCode;
  readonly bookedFleet: FleetCode;
  readonly chargedQuote: Money;
  /** The booked fleet's price, or null when it could not be read. */
  readonly bookedPrice: Money | null;
  /** What the platform absorbs; null when `bookedPrice` is. */
  readonly difference: Money | null;
  readonly capMinor: number;
  readonly overCap: boolean;
  readonly recordedAt: Temporal.Instant;
}

/**
 * What the platform pays fleets beyond the buyer's quote: the fees fleets report
 * (`shipping.fleet_fees`) and the fallback bookings (`shipping.delivery_fallbacks`). Insert-only;
 * every method runs inside the caller's unit of work and is scoped by the Market.
 */
export interface FleetLedgerRepository {
  /** Records a fee once by the fleet's own id: `duplicate` when it was recorded before. */
  recordFee(market: MarketContext, fee: FleetFeeRecord): Promise<'recorded' | 'duplicate'>;

  /** Records the fallback of a seller order once: `exists` when it already has one. */
  recordFallback(
    market: MarketContext,
    fallback: DeliveryFallbackRecord,
  ): Promise<'recorded' | 'exists'>;
}

export const FLEET_LEDGER_REPOSITORY = Symbol('FLEET_LEDGER_REPOSITORY');
