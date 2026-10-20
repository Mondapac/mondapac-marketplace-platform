// Public contracts of the search module (ADR-0008): event types and the facade interface.
// Other modules may import only what this file exports, through ../index.ts.
export {
  SEARCH_ASSISTANT_FACADE,
  type AssistantProduct,
  type AssistantSearchFailure,
  type AssistantSpecial,
  type SearchAssistantFacade,
} from './search-assistant.facade';
