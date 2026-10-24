import type { MarketContext, Result } from '@mondapac/shared-kernel';
import type { CarrierStopInput } from '../../domain/carrier-stop';

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
  readonly temperature: 'ambient' | 'chilled' | 'frozen';
}

export interface CarrierBookingRequest {
  /** The seller order id: the carrier books once per reference, so a retry is harmless. */
  readonly externalReference: string;
  readonly pickup: CarrierStop;
  readonly dropoff: CarrierStop;
  readonly parcel: CarrierParcel;
  readonly mode: 'on_demand' | 'scheduled';
}

/** The carrier's answer to a booking: its own id of the delivery and its status code. */
export interface CarrierBookingAnswer {
  readonly carrierReference: string;
  readonly carrierStatus: string;
}

export type CarrierFailure =
  /** The carrier is not configured for the Market (no settings or no key): nothing was sent. */
  | { readonly code: 'carrier.not-configured' }
  /** A timeout, a network fault, a 5xx or an open circuit: try again later. */
  | { readonly code: 'carrier.unavailable' }
  /** The carrier answered and said no (a 4xx): the same request will not succeed. */
  | { readonly code: 'carrier.refused' };

/**
 * The carrier port of shipping (SHP-02/03): what a real-time carrier adapter implements. Every
 * call is idempotent at the carrier, so the adapter may retry it. A failure is a code only: no
 * carrier answer body, key or personal data reaches a log or an error.
 */
export interface CarrierGateway {
  book(
    market: MarketContext,
    request: CarrierBookingRequest,
  ): Promise<Result<CarrierBookingAnswer, CarrierFailure>>;

  /** Asks the carrier to drop a delivery that has not been picked up yet. */
  cancel(
    market: MarketContext,
    carrierReference: string,
  ): Promise<Result<{ readonly carrierStatus: string }, CarrierFailure>>;
}

export const CARRIER_GATEWAY = Symbol('CARRIER_GATEWAY');
