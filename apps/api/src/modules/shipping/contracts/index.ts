// Public contracts of the shipping module (ADR-0008): the facade interface and the permission
// keys. Other modules may import only what this file exports, through ../index.ts.
export { SHIPPING_AUDIT_ACTIONS } from '../domain/audit';
export {
  SHIPPING_CARRIER_DELIVERY_VIEW,
  SHIPPING_DELIVERY_SETTINGS_MANAGE,
  SHIPPING_DELIVERY_SETTINGS_VIEW,
  SHIPPING_FLEET_SELECTION_MANAGE,
  SHIPPING_FLEET_SELECTION_VIEW,
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
export {
  QUOTE_TTL_MINUTES,
  type MethodQuote,
  type QuotedDelivery,
  type SellerDeliveryQuotes,
} from '../domain/delivery-quote';
export { FLEET_FEE_REASONS, type FleetFeeReason } from '../domain/fleet-fee';
export { DELIVERY_METHODS, type DeliveryMethod } from '../domain/delivery-methods';
export type {
  ChoiceRefusal,
  MethodAvailability,
  SellerDeliveryAvailability,
  UnavailableReason,
  WindowRefusal,
} from '../domain/delivery-settings';
export {
  CarrierDeliveryProgressed,
  DeliveryFallbackOverCap,
  SHIPPING_EVENTS,
} from '../domain/events';
export type { CarrierProgressView } from '../domain/carrier-progress';
export {
  MAX_CARRIER_PROGRESS_IDS,
  SHIPPING_FACADE,
  type CarrierBookingOutcome,
  type CarrierDeliveryProgress,
  type CarrierDeliveryRequest,
  type CarrierDeliveryFailure,
  type CarrierShipment,
  type ChargeFailure,
  type FleetFeeFailure,
  type QuoteDropoff,
  type QuoteFailure,
  type QuoteSeller,
  type ShippingFacade,
  type ShippingFailure,
} from './shipping.facade';
export {
  MAX_REPORT_REGIONS,
  SHIPPING_REPORTING_FACADE,
  type DeliveryRegions,
  type ShippingReportingFacade,
  type ShippingReportingFailure,
} from './shipping-reporting.facade';
