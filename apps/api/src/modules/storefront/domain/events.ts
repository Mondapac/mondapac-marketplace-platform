import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * An admin changed the Market's search-engine indexing switch (SEO admin plan, decision 6). Carries
 * the new version of the SEO settings and nothing else: the Market is on the envelope, there is no
 * actor (events carry none, ADR-0018 decision 4) and no value (a consumer reads the setting). The
 * senior-admin mail of package S6 listens to it.
 */
export const StorefrontSeoIndexingChangedEvent = defineEvent({
  type: 'storefront.seo-indexing-changed.v1',
  aggregateType: 'seo-settings',
  payload: { version: eventField.integer() },
});

export const STOREFRONT_EVENTS: readonly EventDefinition[] = [StorefrontSeoIndexingChangedEvent];
