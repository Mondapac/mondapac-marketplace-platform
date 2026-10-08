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
 * Every event catalog publishes, declared with `defineEvent` and registered with the event
 * catalogue by `CatalogModule`. Each new type changes the catalogue snapshot
 * (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const CATALOG_EVENTS: readonly EventDefinition[] = [VariantAdded, VariantRemoved];
