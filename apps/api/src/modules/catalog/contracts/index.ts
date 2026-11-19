// Public contracts of the catalog module (ADR-0008): event types and the facade interface.
// Other modules may import only what this file exports, through ../index.ts.
export * from './catalog.facade';
export * from './catalog-index.facade';
export * from './catalog-assistant.facade';
export * from './catalog-activities.facade';
export * from './catalog-cultures.facade';
export * from './catalog-filters.facade';
export {
  OfferCreated,
  OfferChangesRequested,
  OfferDeleted,
  OfferMoved,
  OfferPublished,
  ProductRevisionPublished,
  // Consumed by notifications' admin review notice (package 3).
  ProductRevisionSubmitted,
  // Consumed by notifications' seller notices (package 4), with their reason vocabularies.
  IMAGE_TAKEDOWN_REASONS,
  OFFER_CHANGE_REASONS,
  PRODUCT_CHANGE_REASONS,
  OfferListingChanged,
  // Consumed by search: a sell unit switched off or on leaves or rejoins its Offer's document.
  OfferSellUnitChanged,
  OfferTagRemoved,
  OfferTagRestored,
  OfferTagSuspended,
  ProductImageTakenDown,
  // Consumed by search: a renamed or moved category changes the names its products are found by.
  PlatformCategoryChanged,
  PlatformCategoryMoved,
  // Consumed by search: a paused product's Offers leave the index, a resumed one's return.
  ProductPaused,
  ProductResumed,
  // Consumed by notifications' admin notice (the finished platform import).
  PlatformImportFinished,
  PLATFORM_IMPORT_OUTCOMES,
  // Consumed by notifications' seller notice (the finished seller import).
  SellerImportFinished,
  SELLER_IMPORT_OUTCOMES,
  ProductRevisionChangesRequested,
  ProductRevisionChangesRequestedV2,
  VariantAdded,
  VariantRemoved,
  // Multi-culture package 3a: search re-indexes on these (ADR-0047 decision 8); sellers demotes on
  // the last (ADR-0048 security review N1). Search also consumes the tag events for culture_codes.
  CultureStatusChanged,
  CultureCategoryMarkChanged,
  CultureApprovalsInvalidated,
  CULTURE_EVENT_STATUSES,
  OfferTagAdded,
  OfferTagBasisSwitched,
  // Multi-culture package 3a (ADR-0048 security review M3): a merge or an archive changes the live
  // paths, so the culture marks a category's Offers resolve; search re-indexes both subtrees.
  PlatformCategoryMerged,
  PlatformCategoryArchived,
} from '../domain/events';
export { buildOfferMovedMapping } from '../domain/events/offer-moved-payload';
export type { OfferMovedPayloadRefused } from '../domain/events/offer-moved-payload';
export {
  CATALOG_BUSINESS_ACTIVITY_EDIT,
  CATALOG_BUSINESS_ACTIVITY_READ,
  CATALOG_CULTURE_EDIT,
  CATALOG_CULTURE_READ,
  CATALOG_BRAND_EDIT,
  CATALOG_BRAND_READ,
  CATALOG_OWN_IMPORT_RUN,
  CATALOG_OWN_PRODUCT_VIEW,
  CATALOG_PERMISSIONS,
  CATALOG_PLATFORM_IMPORT_RUN,
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_PRODUCT_APPROVE,
  CATALOG_PRODUCT_VIEW,
  CATALOG_VARIANT_VIEW,
} from './permissions';
