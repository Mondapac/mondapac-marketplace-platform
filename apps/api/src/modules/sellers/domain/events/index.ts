import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * The file of a seller exists (sellers design 7.4; slice 1): created from
 * `identity.seller-registered.v1`, or by the deploy-time backfill. Ids only: no name, no
 * address, no state (sellers design 8.3; platform persistence design 5.3).
 */
export const SellerFileCreated = defineEvent({
  type: 'sellers.seller-file-created.v1',
  aggregateType: 'seller-file',
  payload: { sellerId: eventField.id() },
});

/**
 * A tax registration period was recorded or cancelled (sellers design 7.4; slice 3). The seller id
 * only: `tax` reads the period through `taxProfileOf` (Hassan L1), so no answer, date or number
 * travels in the event.
 */
export const TaxRegistrationRecorded = defineEvent({
  type: 'sellers.tax-registration-recorded.v1',
  aggregateType: 'seller-tax-profile',
  payload: { sellerId: eventField.id() },
});

/**
 * Every event sellers publishes, declared with `defineEvent` and registered with the event
 * catalogue by `SellersModule`. Each new type changes the catalogue snapshot
 * (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const SELLERS_EVENTS: readonly EventDefinition[] = [
  SellerFileCreated,
  TaxRegistrationRecorded,
];
