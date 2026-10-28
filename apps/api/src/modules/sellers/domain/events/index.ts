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
 * A seller's business file was submitted for review (sellers design 7.4; slice 5b). Ids and
 * enums only: no store name, no identifier, no address. `resubmission` is true when the file
 * had an earlier revision (a withdrawn one, or later a rejected one), so a consumer can tell a
 * new application from another try. Its own handler (`sellers.after-submission`) tells the
 * reviewers.
 */
export const BusinessFileSubmitted = defineEvent({
  type: 'sellers.business-file-submitted.v1',
  aggregateType: 'seller-file',
  payload: {
    sellerId: eventField.id(),
    revisionId: eventField.id(),
    kind: eventField.enumOf(['onboarding', 'identity-change'] as const),
    authorKind: eventField.enumOf(['seller', 'admin'] as const),
    resubmission: eventField.boolean(),
  },
});

/**
 * A pending revision was withdrawn (sellers design 7.4; slice 5b): the seller edited the draft,
 * or cancelled the submission. Ids and enums only. No consumer yet.
 */
export const BusinessFileWithdrawn = defineEvent({
  type: 'sellers.business-file-withdrawn.v1',
  aggregateType: 'seller-file',
  payload: {
    sellerId: eventField.id(),
    revisionId: eventField.id(),
    cause: eventField.enumOf(['edited', 'cancelled', 'reapply-refused'] as const),
    byKind: eventField.enumOf(['seller', 'admin'] as const),
  },
});

/**
 * A store's public profile texts were saved and published (sellers design 7.4, 3.7; slice 12 part
 * 2). Ids only: no text, no hash. The aggregate id is the store profile's own, derived from the
 * seller id (`derivedId`, a version 7 layout id) and its version the revision number, so a consumer can
 * order a store's events (ADR-0006 decision 3). It is not the seller id: the outbox key (aggregate
 * id, version) is unique and the seller id's versions belong to the business file's events. No consumer yet (the storefront reads the
 * pointer in clear on every call).
 */
export const StoreProfilePublished = defineEvent({
  type: 'sellers.store-profile-published.v1',
  aggregateType: 'store-profile',
  payload: { sellerId: eventField.id(), revisionId: eventField.id() },
});

/**
 * An admin switched a seller's blog access on or off (blog package 1). `unpublishLive` asks the
 * blog to take the seller's live posts off the site (only with `enabled: false`). Ids and flags
 * only. The aggregate id is derived from the seller id and its version is the version of the
 * seller's admin settings row, so the events of one seller are ordered and never collide with the
 * business file's. Consumer: blog (unpublish).
 */
export const SellerBlogAccessChanged = defineEvent({
  type: 'sellers.blog-access-changed.v1',
  aggregateType: 'seller-blog-access',
  payload: {
    sellerId: eventField.id(),
    enabled: eventField.boolean(),
    unpublishLive: eventField.boolean(),
  },
});

/**
 * Every event sellers publishes, declared with `defineEvent` and registered with the event
 * catalogue by `SellersModule`. Each new type changes the catalogue snapshot
 * (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const SELLERS_EVENTS: readonly EventDefinition[] = [
  SellerFileCreated,
  TaxRegistrationRecorded,
  BusinessFileSubmitted,
  BusinessFileWithdrawn,
  StoreProfilePublished,
  SellerBlogAccessChanged,
];
