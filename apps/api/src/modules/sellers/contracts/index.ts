// Public contracts of the sellers module (ADR-0008): event types and the facade interface.
// Other modules may import only what this file exports, through ../index.ts. Event
// definitions are declared in domain/events/ and re-exported here (ADR-0006 decision 6).
export { SELLERS_EVENTS, SellerFileCreated } from '../domain/events';
export type { SellerSummary } from '../domain/seller-summary';
export {
  SELLERS_FACADE,
  type SellersFacade,
  type SellersUnavailable,
  type SellersValidationFailed,
  type SellingEligibilityMap,
} from './sellers.facade';
