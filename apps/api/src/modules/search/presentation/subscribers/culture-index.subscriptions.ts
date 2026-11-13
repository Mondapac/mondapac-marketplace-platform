import type { Id } from '@mondapac/shared-kernel';
import {
  CultureCategoryMarkChanged,
  CultureStatusChanged,
  PlatformCategoryArchived,
  PlatformCategoryMerged,
  OfferTagAdded,
  OfferTagBasisSwitched,
  OfferTagRemoved,
  OfferTagRestored,
  OfferTagSuspended,
} from '../../../catalog';
import {
  CertificationTypeDeactivated,
  IssuerDeactivated,
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
  RequestOfferReindex,
  ReindexRequestReason,
} from '../../application/use-cases/request-offer-reindex.use-case';
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
export const INDEX_ON_CATEGORY_MERGED_SUBSCRIBER = 'search.index-category-merged';
export const INDEX_ON_CATEGORY_ARCHIVED_SUBSCRIBER = 'search.index-category-archived';
export const INDEX_ON_ISSUER_DEACTIVATED_SUBSCRIBER = 'search.index-issuer-deactivated';
export const INDEX_ON_TYPE_DEACTIVATED_SUBSCRIBER = 'search.index-type-deactivated';

/**
 * Search's subscriptions for the `culture_codes` of its documents (multi-culture package 3a;
 * ADR-0047 decision 8; ADR-0048 security review M3): every change of a membership, a seller
 * certificate, an Offer tag, a culture's category mark or visibility, the category tree (merge,
 * archive), a culture's status, a certificate issuer or a certification type re-indexes the Offers
 * it can touch. Each event only names what to look at; `SyncOfferDocuments` re-reads catalog, whose
 * one shared function decides the cultures, so a repeated or out-of-order delivery converges. Entry
 * adapters: the delivery's Market system-actor context goes unchanged to one `system` use case; a
 * refusal throws, so the delivery is retried and, after its last attempt, dead-lettered with an
 * alert. Nothing here throws because a scope is large.
 *
 * - a membership or a seller certificate (approved, expired, revoked): the seller's Offers;
 * - a tag added, removed, suspended, restored or switched to another basis: that Offer;
 * - a culture's mark or visibility row on a category, a merge (source and target) or an archive:
 *   the Offers of the subtree, directly up to the threshold, else handed to the full reindex;
 * - a culture's status, a derecognised issuer (closed-to-new changes no validity) or a deactivated
 *   type: the full reindex is asked for (`RequestOfferReindex`; it runs at its next tick, at most
 *   five minutes later, resumable).
 */
export function cultureIndexSubscriptions(
  sync: SyncOfferDocuments,
  reindex: RequestOfferReindex,
): RegisteredSubscription[] {
  const run = async (
    name: string,
    context: Parameters<SyncOfferDocuments['execute']>[0],
    input: SyncOfferDocumentsInput,
  ): Promise<void> => {
    const result = await sync.execute(context, input);
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
    if (result.value.handedOff === true) await ask(name, context, 'scope-too-large');
  };
  const ask = async (
    name: string,
    context: Parameters<SyncOfferDocuments['execute']>[0],
    reason: ReindexRequestReason,
  ): Promise<void> => {
    const result = await reindex.execute(context, { reason });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  const subtree = (name: string, context: Parameters<typeof run>[1], categoryId: string) =>
    run(name, context, { categoryId: categoryId as Id<'Category'>, handOffAbove: true });
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
        subtree(INDEX_ON_CULTURE_MARK_CHANGED_SUBSCRIBER, context, event.payload.categoryId),
    }),
    subscription({
      name: INDEX_ON_CATEGORY_MERGED_SUBSCRIBER,
      event: PlatformCategoryMerged,
      handle: async (event, _delivery, context) => {
        await subtree(INDEX_ON_CATEGORY_MERGED_SUBSCRIBER, context, event.payload.categoryId);
        await subtree(INDEX_ON_CATEGORY_MERGED_SUBSCRIBER, context, event.payload.mergedIntoId);
      },
    }),
    subscription({
      name: INDEX_ON_CATEGORY_ARCHIVED_SUBSCRIBER,
      event: PlatformCategoryArchived,
      handle: (event, _delivery, context) =>
        subtree(INDEX_ON_CATEGORY_ARCHIVED_SUBSCRIBER, context, event.payload.categoryId),
    }),
    subscription({
      name: INDEX_ON_CULTURE_STATUS_CHANGED_SUBSCRIBER,
      event: CultureStatusChanged,
      handle: (_event, _delivery, context) =>
        ask(INDEX_ON_CULTURE_STATUS_CHANGED_SUBSCRIBER, context, 'culture-status'),
    }),
    subscription({
      name: INDEX_ON_ISSUER_DEACTIVATED_SUBSCRIBER,
      event: IssuerDeactivated,
      handle: async (event, _delivery, context) => {
        // closed-to-new keeps every approved certificate valid to its boundary (design 3.5).
        if (event.payload.form !== 'derecognised') return;
        await ask(INDEX_ON_ISSUER_DEACTIVATED_SUBSCRIBER, context, 'issuer-derecognised');
      },
    }),
    subscription({
      name: INDEX_ON_TYPE_DEACTIVATED_SUBSCRIBER,
      event: CertificationTypeDeactivated,
      handle: (_event, _delivery, context) =>
        ask(INDEX_ON_TYPE_DEACTIVATED_SUBSCRIBER, context, 'type-deactivated'),
    }),
  ];
}
