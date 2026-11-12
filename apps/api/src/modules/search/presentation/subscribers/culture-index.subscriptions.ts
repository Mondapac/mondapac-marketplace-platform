import type { Id } from '@mondapac/shared-kernel';
import {
  CultureCategoryMarkChanged,
  CultureStatusChanged,
  OfferTagAdded,
  OfferTagBasisSwitched,
  OfferTagRemoved,
  OfferTagRestored,
  OfferTagSuspended,
} from '../../../catalog';
import {
  SellerCertificationApproved,
  SellerCertificationExpired,
  SellerCertificationRevoked,
} from '../../../certification';
import { SellerCultureStatusChanged } from '../../../sellers';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type {
  SyncOfferDocuments,
  SyncOfferDocumentsInput,
} from '../../application/use-cases/sync-offer-documents.use-case';

/** The subscriber names: also the `subscriber` of each delivery. */
export const INDEX_ON_SELLER_CULTURE_CHANGED_SUBSCRIBER = 'search.index-seller-culture-changed';
export const INDEX_ON_CERTIFICATE_APPROVED_SUBSCRIBER = 'search.index-certificate-approved';
export const INDEX_ON_CERTIFICATE_EXPIRED_SUBSCRIBER = 'search.index-certificate-expired';
export const INDEX_ON_CERTIFICATE_REVOKED_SUBSCRIBER = 'search.index-certificate-revoked';
export const INDEX_ON_TAG_ADDED_SUBSCRIBER = 'search.index-tag-added';
export const INDEX_ON_TAG_REMOVED_SUBSCRIBER = 'search.index-tag-removed';
export const INDEX_ON_TAG_SUSPENDED_SUBSCRIBER = 'search.index-tag-suspended';
export const INDEX_ON_TAG_RESTORED_SUBSCRIBER = 'search.index-tag-restored';
export const INDEX_ON_TAG_BASIS_SWITCHED_SUBSCRIBER = 'search.index-tag-basis-switched';
export const INDEX_ON_CULTURE_MARK_CHANGED_SUBSCRIBER = 'search.index-culture-mark-changed';
export const INDEX_ON_CULTURE_STATUS_CHANGED_SUBSCRIBER = 'search.index-culture-status-changed';

/**
 * Search's subscriptions for the `culture_codes` of its documents (multi-culture package 3a;
 * ADR-0047 decision 8): every change of a membership, a seller certificate, an Offer tag, a
 * culture's category mark or visibility, or a culture's status re-indexes the Offers it can touch.
 * Each event only names what to look at; `SyncOfferDocuments` re-reads catalog, whose one shared
 * function decides the cultures, so a repeated or out-of-order delivery converges. Entry adapters:
 * the delivery's Market system-actor context goes unchanged to one `system` use case; a refusal
 * throws, so the delivery is retried and, after its last attempt, dead-lettered with an alert.
 *
 * - a membership or a seller certificate (approved, expired, revoked): the seller's Offers;
 * - a tag added, removed, suspended, restored or switched to another basis: that Offer;
 * - a mark or visibility row of a culture on a category: the Offers of that category's subtree;
 * - a culture's status: the Offers whose document holds the culture's code (the attribute
 *   reindex, whose catalog stamp covers the cultures, picks up the Offers it newly shows).
 */
export function cultureIndexSubscriptions(sync: SyncOfferDocuments): RegisteredSubscription[] {
  const run = async (
    name: string,
    context: Parameters<SyncOfferDocuments['execute']>[0],
    input: SyncOfferDocumentsInput,
  ): Promise<void> => {
    const result = await sync.execute(context, input);
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  const seller = (name: string, context: Parameters<typeof run>[1], sellerId: string) =>
    run(name, context, { sellerId: sellerId as Id<'Seller'> });
  const byTag = [
    [INDEX_ON_TAG_ADDED_SUBSCRIBER, OfferTagAdded],
    [INDEX_ON_TAG_REMOVED_SUBSCRIBER, OfferTagRemoved],
    [INDEX_ON_TAG_SUSPENDED_SUBSCRIBER, OfferTagSuspended],
    [INDEX_ON_TAG_RESTORED_SUBSCRIBER, OfferTagRestored],
    [INDEX_ON_TAG_BASIS_SWITCHED_SUBSCRIBER, OfferTagBasisSwitched],
  ] as const;
  return [
    subscription({
      name: INDEX_ON_SELLER_CULTURE_CHANGED_SUBSCRIBER,
      event: SellerCultureStatusChanged,
      handle: (event, _delivery, context) =>
        seller(INDEX_ON_SELLER_CULTURE_CHANGED_SUBSCRIBER, context, event.payload.sellerId),
    }),
    subscription({
      name: INDEX_ON_CERTIFICATE_APPROVED_SUBSCRIBER,
      event: SellerCertificationApproved,
      handle: (event, _delivery, context) =>
        seller(INDEX_ON_CERTIFICATE_APPROVED_SUBSCRIBER, context, event.payload.sellerId),
    }),
    subscription({
      name: INDEX_ON_CERTIFICATE_EXPIRED_SUBSCRIBER,
      event: SellerCertificationExpired,
      handle: (event, _delivery, context) =>
        seller(INDEX_ON_CERTIFICATE_EXPIRED_SUBSCRIBER, context, event.payload.sellerId),
    }),
    subscription({
      name: INDEX_ON_CERTIFICATE_REVOKED_SUBSCRIBER,
      event: SellerCertificationRevoked,
      handle: (event, _delivery, context) =>
        seller(INDEX_ON_CERTIFICATE_REVOKED_SUBSCRIBER, context, event.payload.sellerId),
    }),
    ...byTag.map(([name, event]) =>
      subscription({
        name,
        event,
        handle: (delivered, _delivery, context) =>
          run(name, context, { offerIds: [delivered.payload.offerId as Id<'Offer'>] }),
      }),
    ),
    subscription({
      name: INDEX_ON_CULTURE_MARK_CHANGED_SUBSCRIBER,
      event: CultureCategoryMarkChanged,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_CULTURE_MARK_CHANGED_SUBSCRIBER, context, {
          categoryId: event.payload.categoryId as Id<'Category'>,
        }),
    }),
    subscription({
      name: INDEX_ON_CULTURE_STATUS_CHANGED_SUBSCRIBER,
      event: CultureStatusChanged,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_CULTURE_STATUS_CHANGED_SUBSCRIBER, context, {
          cultureId: event.payload.cultureId as Id<'Culture'>,
        }),
    }),
  ];
}
