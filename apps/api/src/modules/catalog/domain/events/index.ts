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

/** An Offer was published, at its submit or by a reviewer (catalog design 4.4). Ids only. */
export const OfferPublished = defineEvent({
  type: 'catalog.offer-published.v1',
  aggregateType: 'offer',
  payload: { offerId: eventField.id(), productId: eventField.id(), sellerId: eventField.id() },
});

/** The reasons a reviewer may give when an Offer needs changes (catalog design 4.4). */
export const OFFER_CHANGE_REASONS = [
  'content-unclear',
  'description-claim',
  'sku-or-condition',
  'handling-unclear',
  'other',
] as const;
export type OfferChangeReason = (typeof OFFER_CHANGE_REASONS)[number];

/** A reviewer asked the seller to change an Offer; the reason is a code, never text. */
export const OfferChangesRequested = defineEvent({
  type: 'catalog.offer-changes-requested.v1',
  aggregateType: 'offer',
  payload: {
    offerId: eventField.id(),
    productId: eventField.id(),
    sellerId: eventField.id(),
    reasonCode: eventField.enumOf(OFFER_CHANGE_REASONS),
  },
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
 * A revision of a product was submitted (catalog design 4.2 row 1; 9.4). Written for every
 * submit, whether the revision then waits for review or is published at once. Ids and the scope.
 */
export const ProductRevisionSubmitted = defineEvent({
  type: 'catalog.product-revision-submitted.v1',
  aggregateType: 'product',
  payload: {
    productId: eventField.id(),
    revisionId: eventField.id(),
    scope: eventField.enumOf(['platform', 'seller'] as const),
  },
});

/**
 * A revision became the product's published one (catalog design 4.2 rows 1, 3, 4; AC 36 for a tax
 * override). `previousRevisionId` is absent for the first publication. Ids and the scope.
 */
export const ProductRevisionPublished = defineEvent({
  type: 'catalog.product-revision-published.v1',
  aggregateType: 'product',
  payload: {
    productId: eventField.id(),
    revisionId: eventField.id(),
    previousRevisionId: eventField.optional(eventField.id()),
    scope: eventField.enumOf(['platform', 'seller'] as const),
  },
});

/**
 * A reviewer sent a pending product revision back to its seller (catalog design 4.2 row 5). The
 * reason is a code of the Market list, never text. Ids and the scope.
 */
export const ProductRevisionChangesRequested = defineEvent({
  type: 'catalog.product-revision-changes-requested.v1',
  aggregateType: 'product',
  payload: {
    productId: eventField.id(),
    revisionId: eventField.id(),
    reasonCode: eventField.enumOf(OFFER_CHANGE_REASONS),
    scope: eventField.enumOf(['platform', 'seller'] as const),
  },
});

/** The basis of a tag in an event payload (catalog design 9.4), lower-case as event enums are. */
const TAG_BASIS_FIELD = eventField.optional(eventField.enumOf(['seller', 'manufacturer'] as const));

/**
 * The tag events of catalog design 9.4. The payload names the tag by its id, not its type code:
 * the event vocabulary has no kind for a Market's open code list (PP 5.3), so a consumer reads the
 * type through catalog. Ids and the basis only; no reason, no actor.
 */
const tagPayload = { offerId: eventField.id(), tagId: eventField.id(), basis: TAG_BASIS_FIELD };

/** A tag became `active` from a fresh allowed decision of a seller's add (design 5.3). */
export const OfferTagAdded = defineEvent({
  type: 'catalog.offer-tag-added.v1',
  aggregateType: 'offer',
  payload: tagPayload,
});

/** A seller removed an `active` tag (design 5.3). */
export const OfferTagRemoved = defineEvent({
  type: 'catalog.offer-tag-removed.v1',
  aggregateType: 'offer',
  payload: tagPayload,
});

/** A fresh decision did not allow a kept tag: it is `suspended` and the Offer off sale (5.3). */
export const OfferTagSuspended = defineEvent({
  type: 'catalog.offer-tag-suspended.v1',
  aggregateType: 'offer',
  payload: tagPayload,
});

/** A fresh allowed decision made a suspended tag `active` again (design 5.3). */
export const OfferTagRestored = defineEvent({
  type: 'catalog.offer-tag-restored.v1',
  aggregateType: 'offer',
  payload: tagPayload,
});

/** A fresh allowed decision kept a tag on another basis (ADR-0012 d6; design 5.3). */
export const OfferTagBasisSwitched = defineEvent({
  type: 'catalog.offer-tag-basis-switched.v1',
  aggregateType: 'offer',
  payload: tagPayload,
});

/** A published Offer went off sale or back on sale through its stored causes (design 4.4). */
export const OfferListingChanged = defineEvent({
  type: 'catalog.offer-listing-changed.v1',
  aggregateType: 'offer',
  payload: { offerId: eventField.id(), listed: eventField.boolean() },
});

/**
 * An admin paused a published product (catalog design 4.1a): the product and all its Offers are
 * off sale until it is resumed. Ids only.
 */
export const ProductPaused = defineEvent({
  type: 'catalog.product-paused.v1',
  aggregateType: 'product',
  payload: { productId: eventField.id() },
});

/** An admin resumed a paused product (catalog design 4.1a). Ids only. */
export const ProductResumed = defineEvent({
  type: 'catalog.product-resumed.v1',
  aggregateType: 'product',
  payload: { productId: eventField.id() },
});

/** A SELLER product was withdrawn, terminally (catalog design 4.1). Ids only. */
export const ProductWithdrawn = defineEvent({
  type: 'catalog.product-withdrawn.v1',
  aggregateType: 'product',
  payload: { productId: eventField.id() },
});

/** A PLATFORM product was retired, terminally (catalog design 4.1; CAT-48). Ids only. */
export const ProductRetired = defineEvent({
  type: 'catalog.product-retired.v1',
  aggregateType: 'product',
  payload: { productId: eventField.id() },
});

/** The reasons a reviewer may give when a photo is taken down (catalog design 10.5). */
export const IMAGE_TAKEDOWN_REASONS = [
  'certification-mark',
  'misleading',
  'rights',
  'unsafe-or-illegal',
  'other',
] as const;
export type ImageTakedownReason = (typeof IMAGE_TAKEDOWN_REASONS)[number];

/**
 * A reviewer took a product photo down (catalog design 10.5): its files are removed and it is no
 * longer served. The aggregate version is 2 (created, then taken down: the move is forward-only).
 * Ids and the reason code.
 */
export const ProductImageTakenDown = defineEvent({
  type: 'catalog.image-taken-down.v1',
  aggregateType: 'product-image',
  payload: {
    productId: eventField.id(),
    imageId: eventField.id(),
    reasonCode: eventField.enumOf(IMAGE_TAKEDOWN_REASONS),
  },
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
  OfferPublished,
  OfferChangesRequested,
  OfferMoved,
  PlatformCategoryCreated,
  ProductRevisionSubmitted,
  ProductRevisionPublished,
  ProductRevisionChangesRequested,
  ProductImageTakenDown,
  OfferTagAdded,
  OfferTagRemoved,
  OfferTagSuspended,
  OfferTagRestored,
  OfferTagBasisSwitched,
  OfferListingChanged,
  ProductPaused,
  ProductResumed,
  ProductWithdrawn,
  ProductRetired,
];
