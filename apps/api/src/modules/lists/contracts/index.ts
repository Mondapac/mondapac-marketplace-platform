// Public contracts of the lists module (ADR-0008): other modules may import only what this file
// exports, through ../index.ts.
export {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  SAVED_FILTER_STORE,
  type SavedFilterStore,
  type StoredFilter,
  type StoredFilterVisibility,
  type StoredFilterWrite,
} from './saved-filter-store';
export {
  LIST_DEFINITIONS,
  type ListDefinition,
  type ListPayloadFailure,
  type ListPopulation,
} from './list-definition';
