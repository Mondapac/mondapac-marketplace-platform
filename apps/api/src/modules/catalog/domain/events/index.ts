import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * A variant exists on a product (catalog design 9.4; INV 3.5): a Simple product's single variant
 * at creation, or a Configurable product's variant when it is added to the working copy. Ids only.
 */
export const VariantAdded = defineEvent({
  type: 'catalog.variant-added.v1',
  aggregateType: 'product',
  payload: { productId: eventField.id(), variantId: eventField.id() },
});

/**
 * A variant was retired, once per variant, in the unit that retires it, and never followed by an
 * add of the same id (catalog design 2.3 M-1; Ali B2). Ids only.
 */
export const VariantRemoved = defineEvent({
  type: 'catalog.variant-removed.v1',
  aggregateType: 'product',
  payload: { productId: eventField.id(), variantId: eventField.id() },
});

/**
 * An Offer exists (catalog design 9.4; INV 3.5): created with a seller's own product or on a
 * PLATFORM product. Ids only.
 */
export const OfferCreated = defineEvent({
  type: 'catalog.offer-created.v1',
  aggregateType: 'offer',
  payload: { offerId: eventField.id(), productId: eventField.id(), sellerId: eventField.id() },
});

/** An Offer was deleted, terminally (catalog design 4.4; PRC CF2, INV 3.5). Ids only. */
export const OfferDeleted = defineEvent({
  type: 'catalog.offer-deleted.v1',
  aggregateType: 'offer',
  payload: { offerId: eventField.id(), productId: eventField.id(), sellerId: eventField.id() },
});

/**
 * An Offer moved to a PLATFORM product on a match (catalog design 9.4; PRC CF4, INV V-1). The
 * variant mapping is two lists of the same length read pairwise: `fromVariantIds[i]` becomes
 * `toVariantIds[i]` (the event field kinds hold no list of objects). Built only by
 * `buildOfferMovedMapping`, which enforces equal length, no duplicates and the
 * `maxVariantsPerProduct` cap. Ids only.
 */
export const OfferMoved = defineEvent({
  type: 'catalog.offer-moved.v1',
  aggregateType: 'offer',
  payload: {
    offerId: eventField.id(),
    fromProductId: eventField.id(),
    toProductId: eventField.id(),
    fromVariantIds: eventField.listOf(eventField.id()),
    toVariantIds: eventField.listOf(eventField.id()),
  },
});

/**
 * A platform category exists (catalog design 4.6, 9.3): created by the seed or by an admin.
 * Subscribers read the tree for the category, so the payload holds the id only.
 */
export const PlatformCategoryCreated = defineEvent({
  type: 'catalog.platform-category-created.v1',
  aggregateType: 'platform-category',
  payload: { categoryId: eventField.id() },
});

/**
 * Every event catalog publishes, declared with `defineEvent` and registered with the event
 * catalogue by `CatalogModule`. Each new type changes the catalogue snapshot
 * (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const CATALOG_EVENTS: readonly EventDefinition[] = [
  VariantAdded,
  VariantRemoved,
  OfferCreated,
  OfferDeleted,
  OfferMoved,
  PlatformCategoryCreated,
];
