// Public contracts of the sellers module (ADR-0008): event types and the facade interface.
// Other modules may import only what this file exports, through ../index.ts. Event
// definitions are declared in domain/events/ and re-exported here (ADR-0006 decision 6).
export { SELLERS_EVENTS, SellerFileCreated } from '../domain/events';
export type { ApprovedSellerZone, SellerSummary } from '../domain/seller-summary';
export {
  SELLERS_BUSINESS_IDENTITY_EDIT,
  SELLERS_PERMISSIONS,
  SELLERS_SELLER_FILE_REVIEW,
} from './permissions';
export {
  SELLERS_FACADE,
  type ApprovedSellerZonesMap,
  type SellersFacade,
  type SellersUnavailable,
  type SellersValidationFailed,
  type SellingEligibilityMap,
} from './sellers.facade';
