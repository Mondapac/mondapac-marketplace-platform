import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import {
  OfferChangesRequested,
  OfferPublished,
  OfferTagRemoved,
  OfferTagRestored,
  OfferTagSuspended,
  PlatformImportFinished,
  ProductImageTakenDown,
  ProductRevisionChangesRequested,
  ProductRevisionPublished,
  ProductRevisionSubmitted,
} from '../../../catalog';
import {
  IssuerRequestAnswered,
  SellerCertificationApproved,
  SellerCertificationChangesRequested,
  SellerCertificationDeclined,
  SellerCertificationExpired,
  SellerCertificationExpiryWarningDue,
  SellerCertificationRevoked,
  SellerCertificationSubmitted,
} from '../../../certification';
import { SellerAccessApproved, SellerAccessReinstated } from '../../../identity';
import { LowStockReached } from '../../../inventory';
import { OrderPaid } from '../../../ordering';
import { PriceHoldDecided, PriceHoldOpened } from '../../../pricing';
import { DeliveryFallbackOverCap } from '../../../shipping';
import { BusinessFileSubmitted } from '../../../sellers';
import {
  ADMIN_DELIVERY_FALLBACK_OVER_CAP,
  ADMIN_PLATFORM_IMPORT_FINISHED,
  ADMIN_PRICE_HOLD_OPENED,
  ADMIN_PRODUCT_REVISION_SUBMITTED,
  ADMIN_SELLER_CERTIFICATE_SUBMITTED,
  ADMIN_SELLER_FILE_SUBMITTED,
  SELLER_ACCESS_CHANGED,
  SELLER_CERTIFICATE_DECIDED,
  SELLER_CERTIFICATE_ENDED,
  SELLER_CERTIFICATE_EXPIRING,
  SELLER_IMAGE_TAKEN_DOWN,
  SELLER_ISSUER_REQUEST_ANSWERED,
  SELLER_LOW_STOCK,
  SELLER_OFFER_CHANGES_REQUESTED,
  SELLER_OFFER_PUBLISHED,
  SELLER_OFFER_TAG_CHANGED,
  SELLER_PRICE_HOLD_DECIDED,
  SELLER_PRODUCT_CHANGES_REQUESTED,
  SELLER_PRODUCT_PUBLISHED,
} from '../../domain/in-app-notice';
import type {
  AdminReviewItem,
  RecordAdminReviewNotice,
} from '../../application/use-cases/record-admin-review-notice.use-case';
import type {
  RecordSellerNotice,
  SellerNoticeItem,
} from '../../application/use-cases/record-seller-notice.use-case';
import type { RecordSellerOrderNotices } from '../../application/use-cases/record-seller-order-notices.use-case';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { CallContext } from '@mondapac/shared-kernel';

/** The subscriber name: also the `handler` of `notifications.inbox`. */
export const SELLER_ORDER_NOTICE_SUBSCRIBER = 'notifications.seller-order-notice';

/** The admin review notice subscribers (package 3), one per queue; each is an inbox handler. */
export const ADMIN_CERTIFICATE_NOTICE_SUBSCRIBER = 'notifications.admin-certificate-notice';
export const ADMIN_PRODUCT_REVISION_NOTICE_SUBSCRIBER =
  'notifications.admin-product-revision-notice';
export const ADMIN_SELLER_FILE_NOTICE_SUBSCRIBER = 'notifications.admin-seller-file-notice';
export const ADMIN_PRICE_HOLD_NOTICE_SUBSCRIBER = 'notifications.admin-price-hold-notice';
export const ADMIN_DELIVERY_FALLBACK_NOTICE_SUBSCRIBER =
  'notifications.admin-delivery-fallback-notice';
export const ADMIN_PLATFORM_IMPORT_NOTICE_SUBSCRIBER = 'notifications.admin-platform-import-notice';

/** The seller notice subscribers (package 4), one per event; each is an inbox handler. */
export const SELLER_NOTICE_SUBSCRIBERS = {
  lowStock: 'notifications.seller-low-stock-notice',
  certificateApproved: 'notifications.seller-certificate-approved-notice',
  certificateChangesRequested: 'notifications.seller-certificate-changes-notice',
  certificateDeclined: 'notifications.seller-certificate-declined-notice',
  certificateExpiring: 'notifications.seller-certificate-expiring-notice',
  certificateExpired: 'notifications.seller-certificate-expired-notice',
  certificateRevoked: 'notifications.seller-certificate-revoked-notice',
  issuerRequestAnswered: 'notifications.seller-issuer-request-notice',
  offerPublished: 'notifications.seller-offer-published-notice',
  offerChangesRequested: 'notifications.seller-offer-changes-notice',
  productPublished: 'notifications.seller-product-published-notice',
  productChangesRequested: 'notifications.seller-product-changes-notice',
  tagSuspended: 'notifications.seller-tag-suspended-notice',
  tagRemoved: 'notifications.seller-tag-removed-notice',
  tagRestored: 'notifications.seller-tag-restored-notice',
  imageTakenDown: 'notifications.seller-image-notice',
  priceHoldDecided: 'notifications.seller-price-hold-notice',
  accessApproved: 'notifications.seller-access-approved-notice',
  accessReinstated: 'notifications.seller-access-reinstated-notice',
} as const;

/**
 * Notifications' in-app subscriptions. `ordering.order-paid.v1` becomes one "New order" notice
 * per seller order; each review queue's "submitted" or "opened" event becomes one admin notice
 * (package 3); the seller's stock, certificate, catalog, price and access events become one
 * notice for that seller (package 4). A refusal throws, so the delivery is retried and, after its
 * last attempt, dead-lettered with an alert.
 */
export function inAppNoticeSubscriptions(
  sellerOrders: RecordSellerOrderNotices,
  adminReviews: RecordAdminReviewNotice,
  sellerNotices: RecordSellerNotice,
): RegisteredSubscription[] {
  const review =
    (name: string) =>
    async (item: AdminReviewItem, delivery: EventDelivery, context: CallContext) => {
      const result = await adminReviews.execute(context, { delivery, item });
      if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
    };
  const certificate = review(ADMIN_CERTIFICATE_NOTICE_SUBSCRIBER);
  const revision = review(ADMIN_PRODUCT_REVISION_NOTICE_SUBSCRIBER);
  const sellerFile = review(ADMIN_SELLER_FILE_NOTICE_SUBSCRIBER);
  const priceHold = review(ADMIN_PRICE_HOLD_NOTICE_SUBSCRIBER);
  const deliveryFallback = review(ADMIN_DELIVERY_FALLBACK_NOTICE_SUBSCRIBER);
  const platformImport = review(ADMIN_PLATFORM_IMPORT_NOTICE_SUBSCRIBER);
  const seller =
    (name: string) =>
    async (item: SellerNoticeItem, delivery: EventDelivery, context: CallContext) => {
      const result = await sellerNotices.execute(context, { delivery, item });
      if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
    };
  const names = SELLER_NOTICE_SUBSCRIBERS;
  const bySeller = (sellerId: string) => ({ by: 'seller' as const, sellerId });
  const byOffer = (offerId: string) => ({ by: 'offer' as const, offerId });
  const byProduct = (productId: string) => ({ by: 'product' as const, productId });
  const tagChange =
    (name: string, change: 'suspended' | 'removed' | 'restored') =>
    (
      event: { readonly payload: { readonly offerId: string; readonly tagId: string } },
      delivery: EventDelivery,
      context: CallContext,
    ) =>
      seller(name)(
        {
          kind: SELLER_OFFER_TAG_CHANGED,
          owner: byOffer(event.payload.offerId),
          params: { offerId: event.payload.offerId, tagId: event.payload.tagId, change },
        },
        delivery,
        context,
      );
  const sellerSubscriptions: RegisteredSubscription[] = [
    subscription({
      name: names.lowStock,
      event: LowStockReached,
      handle: (event, delivery, context) =>
        seller(names.lowStock)(
          {
            kind: SELLER_LOW_STOCK,
            owner: bySeller(event.payload.sellerId),
            params: {
              offerId: event.payload.offerId,
              variantId: event.payload.variantId,
              onlyLeft: event.payload.onlyLeft,
            },
          },
          delivery,
          context,
        ),
    }),
    ...(
      [
        [names.certificateApproved, SellerCertificationApproved, 'approved'],
        [
          names.certificateChangesRequested,
          SellerCertificationChangesRequested,
          'changes-requested',
        ],
        [names.certificateDeclined, SellerCertificationDeclined, 'declined'],
      ] as const
    ).map(([name, event, outcome]) =>
      subscription({
        name,
        event,
        handle: (received, delivery, context) =>
          seller(name)(
            {
              kind: SELLER_CERTIFICATE_DECIDED,
              owner: bySeller(received.payload.sellerId),
              params: { sellerCertificationId: received.payload.sellerCertificationId, outcome },
            },
            delivery,
            context,
          ),
      }),
    ),
    subscription({
      name: names.certificateExpiring,
      event: SellerCertificationExpiryWarningDue,
      handle: (event, delivery, context) =>
        seller(names.certificateExpiring)(
          {
            kind: SELLER_CERTIFICATE_EXPIRING,
            owner: bySeller(event.payload.sellerId),
            params: {
              sellerCertificationId: event.payload.sellerCertificationId,
              days: event.payload.thresholdDays,
            },
          },
          delivery,
          context,
        ),
    }),
    ...(
      [
        [names.certificateExpired, SellerCertificationExpired, 'expired'],
        [names.certificateRevoked, SellerCertificationRevoked, 'revoked'],
      ] as const
    ).map(([name, event, cause]) =>
      subscription({
        name,
        event,
        handle: (received, delivery, context) =>
          seller(name)(
            {
              kind: SELLER_CERTIFICATE_ENDED,
              owner: bySeller(received.payload.sellerId),
              params: { sellerCertificationId: received.payload.sellerCertificationId, cause },
            },
            delivery,
            context,
          ),
      }),
    ),
    subscription({
      name: names.issuerRequestAnswered,
      event: IssuerRequestAnswered,
      handle: (event, delivery, context) =>
        seller(names.issuerRequestAnswered)(
          {
            kind: SELLER_ISSUER_REQUEST_ANSWERED,
            owner: bySeller(event.payload.sellerId),
            params: {
              issuerRequestId: event.payload.issuerRequestId,
              outcome: event.payload.outcome,
            },
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: names.offerPublished,
      event: OfferPublished,
      handle: (event, delivery, context) =>
        seller(names.offerPublished)(
          {
            kind: SELLER_OFFER_PUBLISHED,
            owner: bySeller(event.payload.sellerId),
            params: { offerId: event.payload.offerId, productId: event.payload.productId },
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: names.offerChangesRequested,
      event: OfferChangesRequested,
      handle: (event, delivery, context) =>
        seller(names.offerChangesRequested)(
          {
            kind: SELLER_OFFER_CHANGES_REQUESTED,
            owner: bySeller(event.payload.sellerId),
            params: {
              offerId: event.payload.offerId,
              productId: event.payload.productId,
              reason: event.payload.reasonCode,
            },
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: names.productPublished,
      event: ProductRevisionPublished,
      handle: async (event, delivery, context) => {
        // A PLATFORM product is the admins' own: no seller to tell.
        if (event.payload.scope !== 'seller') return;
        await seller(names.productPublished)(
          {
            kind: SELLER_PRODUCT_PUBLISHED,
            owner: byProduct(event.payload.productId),
            params: { productId: event.payload.productId, revisionId: event.payload.revisionId },
          },
          delivery,
          context,
        );
      },
    }),
    subscription({
      name: names.productChangesRequested,
      event: ProductRevisionChangesRequested,
      handle: async (event, delivery, context) => {
        if (event.payload.scope !== 'seller') return;
        await seller(names.productChangesRequested)(
          {
            kind: SELLER_PRODUCT_CHANGES_REQUESTED,
            owner: byProduct(event.payload.productId),
            params: {
              productId: event.payload.productId,
              revisionId: event.payload.revisionId,
              reason: event.payload.reasonCode,
            },
          },
          delivery,
          context,
        );
      },
    }),
    subscription({
      name: names.tagSuspended,
      event: OfferTagSuspended,
      handle: tagChange(names.tagSuspended, 'suspended'),
    }),
    subscription({
      name: names.tagRemoved,
      event: OfferTagRemoved,
      handle: tagChange(names.tagRemoved, 'removed'),
    }),
    subscription({
      name: names.tagRestored,
      event: OfferTagRestored,
      handle: tagChange(names.tagRestored, 'restored'),
    }),
    subscription({
      name: names.imageTakenDown,
      event: ProductImageTakenDown,
      handle: (event, delivery, context) =>
        seller(names.imageTakenDown)(
          {
            kind: SELLER_IMAGE_TAKEN_DOWN,
            owner: byProduct(event.payload.productId),
            params: {
              productId: event.payload.productId,
              imageId: event.payload.imageId,
              reason: event.payload.reasonCode,
            },
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: names.priceHoldDecided,
      event: PriceHoldDecided,
      handle: async (event, delivery, context) => {
        // Superseded: the seller's own new price, a cancel or a retired series ended the hold.
        if (event.payload.outcome === 'superseded') return;
        await seller(names.priceHoldDecided)(
          {
            kind: SELLER_PRICE_HOLD_DECIDED,
            owner: byOffer(event.payload.offerId),
            params: {
              offerId: event.payload.offerId,
              variantId: event.payload.variantId,
              recordId: event.payload.recordId,
              outcome: event.payload.outcome,
              priceKind: event.payload.kind,
            },
          },
          delivery,
          context,
        );
      },
    }),
    ...(
      [
        [names.accessApproved, SellerAccessApproved, 'approved'],
        [names.accessReinstated, SellerAccessReinstated, 'reinstated'],
      ] as const
    ).map(([name, event, change]) =>
      subscription({
        name,
        event,
        handle: (received, delivery, context) =>
          seller(name)(
            {
              kind: SELLER_ACCESS_CHANGED,
              owner: bySeller(received.payload.sellerId),
              params: { change },
            },
            delivery,
            context,
          ),
      }),
    ),
  ];
  return [
    subscription({
      name: SELLER_ORDER_NOTICE_SUBSCRIBER,
      event: OrderPaid,
      handle: async (event, delivery, context) => {
        const result = await sellerOrders.execute(context, {
          delivery,
          orderId: event.payload.orderId,
        });
        if (!result.ok) {
          throw new Error(`${SELLER_ORDER_NOTICE_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: ADMIN_CERTIFICATE_NOTICE_SUBSCRIBER,
      event: SellerCertificationSubmitted,
      handle: (event, delivery, context) =>
        certificate(
          {
            kind: ADMIN_SELLER_CERTIFICATE_SUBMITTED,
            sellerId: event.payload.sellerId,
            sellerCertificationId: event.payload.sellerCertificationId,
            submission: event.payload.kind,
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: ADMIN_PRODUCT_REVISION_NOTICE_SUBSCRIBER,
      event: ProductRevisionSubmitted,
      handle: (event, delivery, context) =>
        revision(
          {
            kind: ADMIN_PRODUCT_REVISION_SUBMITTED,
            productId: event.payload.productId,
            revisionId: event.payload.revisionId,
            scope: event.payload.scope,
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: ADMIN_SELLER_FILE_NOTICE_SUBSCRIBER,
      event: BusinessFileSubmitted,
      handle: (event, delivery, context) =>
        sellerFile(
          {
            kind: ADMIN_SELLER_FILE_SUBMITTED,
            sellerId: event.payload.sellerId,
            fileKind: event.payload.kind,
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: ADMIN_PRICE_HOLD_NOTICE_SUBSCRIBER,
      event: PriceHoldOpened,
      handle: (event, delivery, context) =>
        priceHold(
          {
            kind: ADMIN_PRICE_HOLD_OPENED,
            recordId: event.payload.recordId,
            offerId: event.payload.offerId,
            direction: event.payload.direction,
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: ADMIN_DELIVERY_FALLBACK_NOTICE_SUBSCRIBER,
      event: DeliveryFallbackOverCap,
      handle: (event, delivery, context) =>
        deliveryFallback(
          {
            kind: ADMIN_DELIVERY_FALLBACK_OVER_CAP,
            sellerOrderId: event.payload.sellerOrderId,
            sellerId: event.payload.sellerId,
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: ADMIN_PLATFORM_IMPORT_NOTICE_SUBSCRIBER,
      event: PlatformImportFinished,
      handle: (event, delivery, context) =>
        platformImport(
          {
            kind: ADMIN_PLATFORM_IMPORT_FINISHED,
            importId: event.payload.importId,
            outcome: event.payload.outcome,
          },
          delivery,
          context,
        ),
    }),
    ...sellerSubscriptions,
  ];
}
