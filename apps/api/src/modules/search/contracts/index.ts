// Public contracts of the search module (ADR-0008): event types and the facade interface.
// Other modules may import only what this file exports, through ../index.ts.
export {
  SEARCH_ASSISTANT_FACADE,
  type AssistantBadge,
  type AssistantOffer,
  type AssistantProduct,
  type AssistantProductDetail,
  type AssistantSearchFailure,
  type AssistantSpecial,
  type SearchAssistantFacade,
} from './search-assistant.facade';
export {
  SEARCH_SUPPLY_FACADE,
  type LiveListingCounts,
  type SearchSupplyFacade,
} from './search-supply.facade';
export { SEARCH_REPORTING_FACADE, type SearchReportingFacade } from './search-reporting.facade';
