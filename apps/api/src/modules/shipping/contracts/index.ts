// Public contracts of the shipping module (ADR-0008): the facade interface and the permission
// keys. Other modules may import only what this file exports, through ../index.ts.
export { SHIPPING_AUDIT_ACTIONS } from '../domain/audit';
export {
  SHIPPING_DELIVERY_SETTINGS_MANAGE,
  SHIPPING_DELIVERY_SETTINGS_VIEW,
  SHIPPING_FLAT_FEE_MANAGE,
  SHIPPING_FLAT_FEE_VIEW,
  SHIPPING_FLEET_SELECTION_MANAGE,
  SHIPPING_FLEET_SELECTION_VIEW,
  SHIPPING_OWN_FEE_VIEW,
  SHIPPING_PERMISSIONS,
} from './permissions';
// The pure margin function, for checkout (package 5) and any test of it.
export {
  applyDeliveryMargin,
  ROUNDING_STEPS,
  type DeliveryMargin,
  type DeliveryPricing,
  type PricedDelivery,
  type RoundingStepMinor,
} from '../domain/delivery-margin';
export { DELIVERY_METHODS, type DeliveryMethod } from '../domain/delivery-methods';
export type {
  ChoiceRefusal,
  MethodAvailability,
  SellerDeliveryAvailability,
  UnavailableReason,
  WindowRefusal,
} from '../domain/delivery-settings';
export { CarrierDeliveryProgressed, SHIPPING_EVENTS } from '../domain/events';
export {
  SHIPPING_FACADE,
  type CarrierBookingOutcome,
  type CarrierDeliveryProgress,
  type CarrierDeliveryRequest,
  type CarrierDeliveryFailure,
  type CarrierShipment,
  type CheckoutShippingFees,
  type FlatFeeMap,
  type QuoteDropoff,
  type ShippingFacade,
  type ShippingFailure,
} from './shipping.facade';
