// Public contracts of the catalog module (ADR-0008): event types and the facade interface.
// Other modules may import only what this file exports, through ../index.ts.
export * from './catalog.facade';
export * from './catalog-index.facade';
export * from './catalog-assistant.facade';
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
  OfferListingChanged,
  OfferTagRemoved,
  OfferTagRestored,
  OfferTagSuspended,
  ProductImageTakenDown,
  // Consumed by search: a paused product's Offers leave the index, a resumed one's return.
  ProductPaused,
  ProductResumed,
  // Consumed by notifications' admin notice (the finished platform import).
  PlatformImportFinished,
  PLATFORM_IMPORT_OUTCOMES,
  ProductRevisionChangesRequested,
  VariantAdded,
  VariantRemoved,
} from '../domain/events';
export { buildOfferMovedMapping } from '../domain/events/offer-moved-payload';
export type { OfferMovedPayloadRefused } from '../domain/events/offer-moved-payload';
export {
  CATALOG_BUSINESS_ACTIVITY_EDIT,
  CATALOG_BUSINESS_ACTIVITY_READ,
  CATALOG_BRAND_EDIT,
  CATALOG_BRAND_READ,
  CATALOG_OWN_PRODUCT_VIEW,
  CATALOG_PERMISSIONS,
  CATALOG_PLATFORM_IMPORT_RUN,
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_PRODUCT_APPROVE,
  CATALOG_PRODUCT_VIEW,
} from './permissions';
