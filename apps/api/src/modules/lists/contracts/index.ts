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
  LIST_REGISTRATION,
  registerLists,
  type ListRegistration,
  type ListDefinition,
  type ListPayloadFailure,
  type ListPopulation,
} from './list-definition';
export {
  COLUMN_PREFERENCE_STORE,
  MAX_PREFERRED_COLUMNS,
  type ColumnPreferenceStore,
  type StoredColumnPreference,
} from './column-preference-store';
export {
  canonicalQuery,
  savedListPayloadParser,
  type ListQueryField,
  type SavedListPayload,
  type SavedListPayloadSpec,
} from './saved-list-payload';
