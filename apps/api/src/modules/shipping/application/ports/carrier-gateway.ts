import type { MarketContext, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { CarrierStopInput } from '../../domain/carrier-stop';
import type {
  FleetCapabilities,
  FleetCode,
  FleetDeliveryStatus,
  Temperature,
} from '../../domain/fleet';

export type { FleetCapabilities, FleetCode, FleetDeliveryStatus } from '../../domain/fleet';

/**
 * One end of a carrier trip, checked by `parseCarrierStop`. PERSONAL DATA (a name, a phone number
 * and an address): passed straight to the carrier, never logged, stored, cached or put in an
 * event or an error.
 */
export type CarrierStop = CarrierStopInput;

/** What is carried, from the Market's carrier settings until offers carry their own sizes. */
export interface CarrierParcel {
  readonly weightGrams: number;
  readonly volumeLitres: number;
  readonly temperature: Temperature;
  /** How many items the seller order holds. */
  readonly itemCount: number;
  /** What the goods are worth (the seller order's total), for a fleet's cover and limits. */
  readonly declaredValue: Money;
}

export interface CarrierBookingRequest {
  /** The seller order id: a fleet that books once per reference makes a retry harmless. */
  readonly externalReference: string;
  readonly pickup: CarrierStop;
  readonly dropoff: CarrierStop;
  readonly parcel: CarrierParcel;
  readonly mode: 'on_demand' | 'scheduled';
  /** The buyer's chosen window for a `scheduled` trip (UTC instants); null otherwise. */
  readonly window: { readonly start: Temporal.Instant; readonly end: Temporal.Instant } | null;
}

/**
 * One end of a quoted trip: its postcode, and the locality and region when they come from a
 * validated or saved address (the seller's approved file, the buyer's address book), for the
 * carrier to locate. Never a street, a name or a phone, and never a suburb the customer typed for
 * the occasion: a quote is asked before anything is bought, and free text would let a customer
 * move the quoted place (Hassan, SHP-02/03).
 */
export interface CarrierQuoteStop {
  readonly postcode: string;
  readonly locality: string | null;
  readonly region: string | null;
}

export interface CarrierQuoteRequest {
  readonly pickup: CarrierQuoteStop;
  readonly dropoff: CarrierQuoteStop;
  readonly parcel: CarrierParcel;
  readonly mode: 'on_demand' | 'scheduled';
}

/** A fleet's price for a trip, without booking it. */
export interface CarrierQuote {
  /** The total in the fleet's currency. */
  readonly price: Money;
  /** Minutes until delivery as the fleet estimates, or null when it gives none. */
  readonly etaMinutes: number | null;
  /** When the price stops holding, or null when the fleet says nothing. */
  readonly expiresAt: Temporal.Instant | null;
}

/** The carrier's answer to a booking: its own id of the delivery and its status code. */
export interface CarrierBookingAnswer {
  readonly carrierReference: string;
  readonly carrierStatus: string;
  /** A link the buyer can follow, when the fleet gives one. */
  readonly trackingUrl: string | null;
}

export type CarrierFailure =
  /** The fleet is off for this Market (no settings, no credentials): nothing was sent. */
  | { readonly code: 'carrier.not-configured' }
  /**
   * The fleet or the network failed (5xx, timeout, open circuit): whether the request reached it
   * is unknown. Retrying is safe only for a fleet with `idempotentBooking: true`.
   */
  | { readonly code: 'carrier.unavailable' }
  /** The carrier answered and said no (a 4xx): the same request will not succeed. */
  | { readonly code: 'carrier.refused' }
  /**
   * The credentials are missing or wrong (401, 403). Guaranteed to mean nothing was booked, so
   * the router may try the next fleet even when this one is not idempotent. An operations
   * problem: it is logged at warn.
   */
  | { readonly code: 'carrier.unauthorized' };

/**
 * The fleet port of shipping: what a delivery provider adapter implements (Mondapac Drive, Uber
 * Direct, Zoom2u, Australia Post, the fake for tests). A failure is a code only: no carrier
 * answer body, key or personal data reaches a log or an error.
 */
export interface CarrierGateway {
  readonly fleet: FleetCode;

  /** What this fleet carries in the Market; null when it is OFF there (never a candidate). */
  capabilities(market: MarketContext): FleetCapabilities | null;

  book(
    market: MarketContext,
    request: CarrierBookingRequest,
  ): Promise<Result<CarrierBookingAnswer, CarrierFailure>>;

  /** The fleet's price and ETA for a trip, without booking it. */
  quote(
    market: MarketContext,
    request: CarrierQuoteRequest,
  ): Promise<Result<CarrierQuote, CarrierFailure>>;

  /**
   * Asks the fleet to drop a delivery that has not been picked up yet. For a fleet with
   * `idempotentBooking: false` a `carrier.refused` here is ambiguous (a lost first answer comes
   * back refused on the retry), so callers must not read it as "still booked".
   */
  cancel(
    market: MarketContext,
    carrierReference: string,
  ): Promise<Result<{ readonly carrierStatus: string }, CarrierFailure>>;

  /** The fleet's current status of a delivery, as the common status and the raw code. */
  status(
    market: MarketContext,
    carrierReference: string,
  ): Promise<
    Result<{ readonly status: FleetDeliveryStatus; readonly carrierStatus: string }, CarrierFailure>
  >;
}
