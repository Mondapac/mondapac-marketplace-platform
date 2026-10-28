import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { PricedDelivery } from '../domain/delivery-margin';
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
  /** The fleet's tracking link for the buyer: a plain https URL, or null when it gave none. */
  readonly trackingUrl: string | null;
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

/** The customer's drop-off as a quote takes it: the postcode of the chosen address only. */
export interface QuoteDropoff {
  readonly postcode: string;
}

/**
 * The fee per seller at checkout, and the sellers whose fee is the carrier's quote: a quote is a
 * tax-inclusive price, whatever the basis of the seller's goods.
 */
export interface CheckoutShippingFees {
  readonly fees: FlatFeeMap;
  readonly quoted: ReadonlySet<Id<'Seller'>>;
}

/** The flat fee of each requested seller that has one; a seller without a fee is absent. */
export type FlatFeeMap = ReadonlyMap<Id<'Seller'>, Money>;

/**
 * What `ordering` calls at checkout and `cart` calls on a read. Each method takes the caller's `CallContext` unchanged.
 */
export interface ShippingFacade {
  /**
   * The flat shipping fee per seller (one fee per seller order, an explicit zero is a fee). At
   * most 100 distinct ids. A seller with no fee set is missing from the map; ordering then
   * refuses that seller's lines (fail closed).
   */
  flatFees(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<FlatFeeMap, ShippingFailure>>;

  /**
   * The shipping fee per seller that checkout charges (SHP-02/03): the real-time carrier's live
   * quote for a seller order it will carry (the Market's carrier on, the seller's approved pickup
   * postcode and the drop-off in its areas), else the flat fee. A failed, slow or foreign-currency
   * quote, or one outside the Market's `quoteBounds`, falls back to the flat fee; a seller with
   * neither is absent (ordering refuses it). Only postcodes go to the carrier. Rule
   * `own-resources`, for checkout under the customer's context. At most 100 distinct ids, and at
   * most 10 quotes per call (the rest keep the flat fee).
   */
  shippingFees(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
    dropoff: QuoteDropoff,
  ): Promise<Result<CheckoutShippingFees, ShippingFailure>>;

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
   * The tracking links of the carrier deliveries of some seller orders of one order, for the
   * buyer's own order page, keyed by seller order id: only a plain https link, only for seller
   * orders that have a carrier delivery with one that belongs to `orderId`. Rule `own-resources`:
   * `ordering` asks under the signed-in customer's context for ids it has just read from that
   * customer's own order, and shipping refuses any actor that is not a customer and any booking
   * of another order. Not exposed over HTTP. A failed read is `shipping.unavailable`: the page
   * shows no link.
   */
  carrierTrackingLinks(
    context: CallContext,
    orderId: string,
    sellerOrderIds: readonly string[],
  ): Promise<Result<ReadonlyMap<string, string>, ShippingFailure>>;

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
