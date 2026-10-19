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
  VariantAdded,
  VariantRemoved,
} from '../domain/events';
export { buildOfferMovedMapping } from '../domain/events/offer-moved-payload';
export type { OfferMovedPayloadRefused } from '../domain/events/offer-moved-payload';
export {
  CATALOG_PERMISSIONS,
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_PRODUCT_APPROVE,
  CATALOG_PRODUCT_VIEW,
} from './permissions';
