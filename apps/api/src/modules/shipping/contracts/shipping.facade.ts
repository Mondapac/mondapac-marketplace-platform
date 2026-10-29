import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { PricedDelivery } from '../domain/delivery-margin';
import type { QuotedDelivery, SellerDeliveryQuotes } from '../domain/delivery-quote';
import type { ChoiceRefusal, SellerDeliveryAvailability } from '../domain/delivery-settings';

export type ShippingFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  /** The read failed: callers fail closed and never read this as "no fee". */
  | { readonly code: 'shipping.unavailable' };

/**
 * A seller order to hand to the real-time carrier, from `ordering` once the order is paid. The
 * drop-off is PERSONAL DATA (the customer's name, phone and address): shipping passes it to the
 * carrier and never stores, logs or forwards it anywhere else.
 */
export interface CarrierDeliveryRequest {
  readonly orderId: string;
  readonly sellerOrderId: string;
  readonly sellerId: string;
  /**
   * How the buyer wants it carried: `instant` (under 2 hours), `same_day` (before the cut-off) or
   * `scheduled` (the buyer's window, ISO UTC instants). A pickup is never booked.
   */
  readonly service: {
    readonly method: 'instant' | 'same_day' | 'scheduled';
    readonly window: { readonly start: string; readonly end: string } | null;
  };
  readonly dropoff: {
    readonly contactName: string;
    readonly contactPhone: string;
    /** The address lines in the Market's order, without the postcode. */
    readonly addressLines: readonly string[];
    readonly postcode: string;
    /**
     * The suburb or town and the state or region of the saved delivery address (never text typed
     * for the occasion), so a fleet can locate the stop. Optional until every caller sends them.
     */
    readonly locality?: string;
    readonly region?: string | null;
    readonly notes: string | null;
  };
  /**
   * The fleet the buyer was quoted and charged for and its price (the seller order's frozen
   * quote), when there is one. The router tries that fleet first; when it books another, the
   * platform absorbs the extra cost (up to the Market's cap, else an admin is alerted) and the
   * buyer is never charged more.
   */
  readonly charged?: {
    readonly fleet: string;
    /** The fleet's price in minor units of the Market currency (not the margin). */
    readonly quoteMinor: number;
  };
  /**
   * What is carried, for the fleets' limits (items, value, weight, temperature, classes).
   * Optional: what is missing is taken from the Market's parcel defaults (one item, no value).
   */
  readonly parcel?: {
    readonly itemCount?: number;
    /** The seller order's total, in minor units of the Market currency. */
    readonly declaredValueMinor?: number;
    readonly weightGrams?: number;
    readonly temperature?: 'ambient' | 'chilled' | 'frozen';
    /** Classes of the goods a fleet may refuse (for example `alcohol`). */
    readonly classes?: readonly string[];
  };
}

/**
 * What `bookCarrierDelivery` did. `booked`: the carrier holds it now; `already-booked`: an
 * earlier call booked it (nothing was sent); `no-carrier`: the `real_time_delivery` strategy
 * does not apply (no fleet is on for the Market, or none can carry the order); `refused`: every
 * fleet that could carry it said no; `unknown`: a fleet that cannot dedupe a repeated booking
 * went quiet, so the order may be booked there (never repeated, never given to another fleet).
 * In these three cases the seller does nothing: the order needs the platform's attention, and
 * ordering records that state.
 */
export type CarrierBookingOutcome =
  'booked' | 'already-booked' | 'no-carrier' | 'refused' | 'unknown';

/** The progress of a carrier delivery as shipping tracks it (see the booking rules). */
export type CarrierDeliveryProgress =
  'booked' | 'picked-up' | 'delivered' | 'exception' | 'cancelled';

/** A seller order's carrier delivery, for `ordering` to record the shipment and the delivery. */
export interface CarrierShipment {
  readonly sellerOrderId: Id<'SellerOrder'>;
  /** The name of the fleet that carries it, from the Market's settings. */
  readonly carrierName: string;
  /** The carrier's id of the delivery: the tracking reference. */
  readonly trackingRef: string;
  readonly progress: CarrierDeliveryProgress;
}

export type CarrierDeliveryFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields?: readonly { path: string; code: string }[];
    }
  /** The carrier or a read is out of reach: the caller retries later; nothing was booked. */
  | { readonly code: 'shipping.carrier-unavailable' }
  | { readonly code: 'shipping.carrier-delivery-not-found' };

/**
 * Where the buyer's order goes, as a quote takes it: the postcode of a saved address, and its
 * suburb and region (never a name, a street or free text typed for the occasion).
 */
export interface QuoteDropoff {
  readonly postcode: string;
  readonly locality: string | null;
  readonly region: string | null;
}

/** One seller order a quote is asked for: its parcel is the Market's default size with these. */
export interface QuoteSeller {
  readonly sellerId: Id<'Seller'>;
  readonly itemCount: number;
  /** The seller order's goods total in minor units of the Market currency, for fleet limits. */
  readonly declaredValueMinor: number;
}

export type QuoteFailure =
  | ShippingFailure
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    };

/** What `chargeDelivery` can refuse besides the usual failures. */
export type ChargeFailure =
  | ShippingFailure
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** The quote id is unknown, or it is another buyer's, seller's, method's or address's. */
  | { readonly code: 'shipping.quote-not-found' }
  /** No fleet can carry the order, or none gave a price now. */
  | { readonly code: 'shipping.quote-unavailable' }
  /** The quote the buyer saw had expired and the price is now `quote`: the buyer confirms it. */
  | { readonly code: 'shipping.quote-changed'; readonly quote: QuotedDelivery };

/** What `recordFleetFee` can refuse. */
export type FleetFeeFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** The fleet holds no booking of this seller order (yet): report again later. */
  | { readonly code: 'shipping.carrier-delivery-not-found' }
  | { readonly code: 'shipping.unavailable' };

/**
 * What `ordering` calls at checkout and `cart` calls on a read. Each method takes the caller's `CallContext` unchanged.
 */
export interface ShippingFacade {
  /**
   * For each asked seller of the signed-in buyer's checkout (at most 10): the delivery methods open
   * now with the reason for each that is not, and the price of every delivering method that is
   * open: the fleet the router picks, its quote, the Market's margin and what the buyer pays, in
   * the Market currency and stored, so checkout charges it and never a price the client sends. A
   * method no fleet can carry is `no-fleet`; one whose fleets gave no usable price now is
   * `failed`. A quote that holds (10 minutes, never past the fleet's expiry) is reused for the
   * same buyer, seller, method and address. Rule `own-resources`; only the postcodes and places of
   * validated or saved addresses go to a fleet (SHP-02/03). Delivery models, package 5.
   */
  quoteDeliveries(
    context: CallContext,
    request: { readonly sellers: readonly QuoteSeller[]; readonly dropoff: QuoteDropoff },
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, SellerDeliveryQuotes>, QuoteFailure>>;

  /**
   * The delivery price checkout charges for one seller order. With the `quoteId` the buyer saw,
   * that stored quote while it holds; once it stopped holding, fleets are asked again and, when
   * the price is not the one the buyer saw, `shipping.quote-changed` carries the new quote and
   * nothing is charged. Without a `quoteId` the quote that holds is charged, or a new one is asked.
   * Rule `own-resources`, under the customer's context.
   */
  chargeDelivery(
    context: CallContext,
    request: {
      readonly seller: QuoteSeller;
      readonly method: string;
      readonly quoteId: string | null;
      readonly dropoff: QuoteDropoff;
    },
  ): Promise<Result<QuotedDelivery, ChargeFailure>>;

  /**
   * Records a fee a fleet charged the PLATFORM for a delivery (cancel, waiting, return) in the
   * fleet-fee ledger, once by the fleet's own id of the fee (`externalRef`): a repeat answers
   * `duplicate`. This is the hook the fleet adapters call when their webhook or invoice reports a
   * fee. The buyer is never charged these. `amount` is a string of minor units in the Market
   * currency, above zero; `occurredAt` an ISO instant. The seller order must have a booking with
   * that fleet. Rule `system`.
   */
  recordFleetFee(
    context: CallContext,
    report: {
      readonly fleet: string;
      readonly sellerOrderId: string;
      readonly reason: 'cancel' | 'waiting' | 'return' | 'other';
      readonly amount: string;
      readonly externalRef: string;
      readonly occurredAt: string;
    },
  ): Promise<Result<'recorded' | 'duplicate', FleetFeeFailure>>;

  /**
   * The asked sellers (at most 100 distinct ids) that have an approved pickup address: those whose
   * buyer may choose in-person pickup (delivery models, package 2). Rule `own-resources`, for
   * checkout under the customer's context. A failed read is `shipping.unavailable`: callers fail
   * closed and never read it as "no pickup".
   */
  pickupAvailability(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<ReadonlySet<Id<'Seller'>>, ShippingFailure>>;

  /**
   * The delivery methods each asked seller (at most 100 distinct ids) offers right now, with the
   * reason for every one that is not: `platform-off` (the Market switched the method off),
   * `seller-unsupported` (an admin did not give it to this seller), `past-cut-off` (same day,
   * after today's cut-off in the seller's zone) and `no-pickup-address` (pickup without an
   * approved pickup address). The answer carries the cut-off and the scheduled days and window
   * length for a screen. Public configuration: the same answer for every caller. A failed read
   * is `shipping.unavailable`: callers fail closed and never read it as "everything is open".
   * Delivery models, package 4.
   */
  deliveryAvailability(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, SellerDeliveryAvailability>, ShippingFailure>>;

  /**
   * Whether one seller order may be delivered the way the buyer chose: the method is open now
   * for the seller and, for `scheduled`, the window (ISO UTC instants) starts in the future, no
   * later than the Market's days ahead and lasts the configured length. `reason` says why not
   * (the codes above, or `window-in-past`, `window-too-far`, `window-length`, `window-missing`).
   * `ordering`'s delivery-method policy asks this at checkout. Fails closed like the read above.
   */
  deliveryChoice(
    context: CallContext,
    request: {
      readonly sellerId: Id<'Seller'>;
      readonly method: string;
      readonly window: { readonly start: string; readonly end: string } | null;
    },
  ): Promise<
    Result<{ readonly allowed: boolean; readonly reason: ChoiceRefusal | null }, ShippingFailure>
  >;

  /**
   * What the buyer pays for a delivery whose fleet quote is `quote` (in the Market currency): the
   * quote plus the Market's margin, rounded up to its step. `margin` is what the platform adds
   * (the rounding included), so `total` = `quote` + `margin`. For checkout (package 5), under the
   * customer's context. `validation.failed` for a quote in another currency or a negative one.
   */
  priceDelivery(
    context: CallContext,
    quote: Money,
  ): Promise<Result<PricedDelivery, ShippingFailure>>;

  /**
   * Whether the Market delivers to the postcode: in a ServiceArea open for delivery. Anyone may
   * ask (the areas are public configuration). `validation.failed` for a postcode that is not 1
   * to 16 printable characters.
   */
  deliversTo(context: CallContext, postcode: string): Promise<Result<boolean, ShippingFailure>>;

  /**
   * The `real_time_delivery` FulfillmentStrategy (SHP-02/03): books the seller order with the
   * Market's real-time carrier when it applies, idempotent by the seller order id (the carrier's
   * `externalReference`). Rule `system`, for ordering's handlers of `ordering.order-paid.v1` (scheduled) and `ordering.seller-order-ready.v1` (instant, same day).
   * `shipping.carrier-unavailable` means try again later.
   */
  bookCarrierDelivery(
    context: CallContext,
    request: CarrierDeliveryRequest,
  ): Promise<Result<CarrierBookingOutcome, CarrierDeliveryFailure>>;

  /**
   * The carrier delivery of a seller order behind `shipping.carrier-delivery-progressed.v1`.
   * Rule `system`. A seller order without one is `shipping.carrier-delivery-not-found`.
   */
  carrierShipment(
    context: CallContext,
    sellerOrderId: string,
  ): Promise<Result<CarrierShipment, CarrierDeliveryFailure>>;

  /**
   * Asks the carrier to drop the delivery of a seller order that is not picked up yet. Rule
   * `system`, for ordering when an order is cancelled after payment. `cancelled`: the carrier
   * dropped it now or before; `not-cancellable`: already picked up, delivered or failed;
   * `none`: the seller order has no carrier delivery; `unknown`: the fleet cannot dedupe, so its
   * refusal does not say whether the delivery is still booked (an admin checks).
   */
  cancelCarrierDelivery(
    context: CallContext,
    sellerOrderId: string,
  ): Promise<Result<'cancelled' | 'not-cancellable' | 'none' | 'unknown', CarrierDeliveryFailure>>;
}

/** Nest token of the {@link ShippingFacade}, provided and exported by `ShippingModule`. */
export const SHIPPING_FACADE = Symbol('SHIPPING_FACADE');
