import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

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
  readonly dropoff: {
    readonly contactName: string;
    readonly contactPhone: string;
    /** The address lines in the Market's order, without the postcode. */
    readonly addressLines: readonly string[];
    readonly postcode: string;
    readonly notes: string | null;
  };
}

/**
 * What `bookCarrierDelivery` did. `booked`: the carrier holds it now; `already-booked`: an
 * earlier call booked it (nothing was sent); `seller-managed`: the `real_time_delivery`
 * strategy does not apply (carrier off for the Market, or either end outside its areas), the
 * seller ships as before; `refused`: the carrier said no, the seller ships as before.
 */
export type CarrierBookingOutcome = 'booked' | 'already-booked' | 'seller-managed' | 'refused';

/** The progress of a carrier delivery as shipping tracks it (see the booking rules). */
export type CarrierDeliveryProgress =
  'booked' | 'picked-up' | 'delivered' | 'exception' | 'cancelled';

/** A seller order's carrier delivery, for `ordering` to record the shipment and the delivery. */
export interface CarrierShipment {
  readonly sellerOrderId: Id<'SellerOrder'>;
  /** The carrier name to show, from the Market's carrier settings. */
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
   * Whether the Market delivers to the postcode: in a ServiceArea open for delivery. Anyone may
   * ask (the areas are public configuration). `validation.failed` for a postcode that is not 1
   * to 16 printable characters.
   */
  deliversTo(context: CallContext, postcode: string): Promise<Result<boolean, ShippingFailure>>;

  /**
   * The `real_time_delivery` FulfillmentStrategy (SHP-02/03): books the seller order with the
   * Market's real-time carrier when it applies, idempotent by the seller order id (the carrier's
   * `externalReference`). Rule `system`, for ordering's handler of `ordering.order-paid.v1`.
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
   * `none`: the seller order has no carrier delivery.
   */
  cancelCarrierDelivery(
    context: CallContext,
    sellerOrderId: string,
  ): Promise<Result<'cancelled' | 'not-cancellable' | 'none', CarrierDeliveryFailure>>;
}

/** Nest token of the {@link ShippingFacade}, provided and exported by `ShippingModule`. */
export const SHIPPING_FACADE = Symbol('SHIPPING_FACADE');
