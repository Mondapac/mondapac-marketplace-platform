// Public contracts of the sellers module (ADR-0008): event types and the facade interface.
// Other modules may import only what this file exports, through ../index.ts. Event
// definitions are declared in domain/events/ and re-exported here (ADR-0006 decision 6).
export { SELLERS_EVENTS, SellerFileCreated } from '../domain/events';
export type { ApprovedSellerZone, SellerSummary } from '../domain/seller-summary';
export {
  SELLERS_BUSINESS_IDENTITY_EDIT,
  SELLERS_PERMISSIONS,
  SELLERS_SELLER_FILE_REVIEW,
  SELLERS_SELLER_VIEW,
} from './permissions';
// The approved-seller-zones contract file (reader interface and token) is deliberately not
// exported: only certification's application layer imports it by path (dependency-cruiser).
export type { ApprovedSellerZonesMap } from './approved-seller-zones.contract';
export {
  SELLERS_FACADE,
  type SellersFacade,
  type SellersUnavailable,
  type SellersValidationFailed,
  type SellingEligibilityMap,
} from './sellers.facade';
