import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { SubjectRateLimits } from '../../platform/rate-limit/subject-rate-limits';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import {
  registerPermissions,
  registerStepUpActions,
  STEP_UP_CONSUMER,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CART_CHECKOUT_FACADE, CartModule } from '../cart';
import { CatalogModule } from '../catalog';
import { ListsModule, registerLists } from '../lists';
import { ORDERING_LISTS } from './application/saved-views/list-definitions';
import { COMMISSION_PAYOUTS_FACADE, CommissionPayoutsModule } from '../commission-payouts';
import { CUSTOMERS_CHECKOUT_FACADE, CustomersModule } from '../customers';
import { IdentityModule } from '../identity';
import { InventoryModule } from '../inventory';
import { INVENTORY_ORDERING_PORT } from '../inventory/contracts/ordering-port';
import { SellersModule } from '../sellers';
import { PROMOTIONS_FACADE, PromotionsModule } from '../promotions';
import { SHIPPING_FACADE, ShippingModule } from '../shipping';
import { TAX_FACADE, TaxModule } from '../tax';
import type { OrderingDependencies } from './application/checkout-flow';
import {
  MARKET_ZONES,
  SHIP_TO_RETENTION_REPOSITORY,
} from './application/ports/ship-to-retention.repository';
import type { ShipToRetentionDependencies } from './application/ship-to-retention-flow';
import { AdminSetShipToRetention } from './application/use-cases/admin-set-ship-to-retention.use-case';
import { AdminViewShipToRetention } from './application/use-cases/admin-view-ship-to-retention.use-case';
import { PurgeSettledShipTo } from './application/use-cases/purge-settled-ship-to.use-case';
import { ORDERING_STEP_UP_ACTIONS } from './contracts/step-up';
import { AdminShipToRetentionController } from './presentation/admin-ship-to-retention.controller';
import { AdminShipmentsController } from './presentation/admin-shipments.controller';
import { AdminListShipments } from './application/use-cases/admin-list-shipments.use-case';
import {
  ADMIN_SHIPMENT_LIST_READER,
  type AdminShipmentListReader,
} from './application/ports/admin-shipment-list.reader';
import { AdminDocumentsController } from './presentation/admin-documents.controller';
import { AdminListDocuments } from './application/use-cases/admin-list-documents.use-case';
import {
  ADMIN_DOCUMENT_LIST_READER,
  type AdminDocumentListReader,
} from './application/ports/admin-document-list.reader';
import { AdminRefundsController } from './presentation/admin-refunds.controller';
import { AdminListRefunds } from './application/use-cases/admin-list-refunds.use-case';
import {
  ADMIN_REFUND_LIST_READER,
  type AdminRefundListReader,
} from './application/ports/admin-refund-list.reader';
import type { OrderLabels } from './application/ports/order-labels';
import type { UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { purgeSettledShipToJob } from './presentation/jobs/purge-settled-ship-to.job';
import { CHECKOUT_GATEWAY } from './application/ports/checkout-gateway';
import { DELIVERY_METHOD_POLICY } from './application/ports/delivery-method-policy';
import { ORDER_LABELS } from './application/ports/order-labels';
import { ORDER_TAX_CATEGORIES } from './application/ports/order-tax-categories';
import { ORDER_PRODUCTS } from './application/ports/order-products';
import { ORDER_REPOSITORY } from './application/ports/order.repository';
import { PAYMENT_ATTEMPT_LIMITS } from './application/ports/payment-attempt-limits';
import { PICKUP_CODE_REPOSITORY } from './application/ports/pickup-code.repository';
import { PICKUP_CODE_VAULT } from './application/ports/pickup-code-vault';
import { REFUND_REPOSITORY } from './application/ports/refund.repository';
import { ORDERING_POLICY } from './application/ports/ordering-policy';
import { SHIP_TO_CIPHER } from './application/ports/ship-to-cipher';
import { SAVED_FILTER_REPOSITORY } from './application/ports/saved-filter.repository';
import type { SavedViewDependencies } from './application/saved-views/saved-view-shared';
import { AdminSavedFilterCreate } from './application/use-cases/admin-saved-filter-create.use-case';
import { AdminSavedFilterDelete } from './application/use-cases/admin-saved-filter-delete.use-case';
import { AdminSavedFilterUpdate } from './application/use-cases/admin-saved-filter-update.use-case';
import { AdminSavedFiltersList } from './application/use-cases/admin-saved-filters-list.use-case';
import { OrderNoteProbe } from './application/use-cases/order-note-probe.use-case';
import { OrderRefundProbe } from './application/use-cases/order-refund-probe.use-case';
import { SellerOrderConfirmPickupProbe } from './application/use-cases/seller-order-confirm-pickup-probe.use-case';
import { SellerOrderMarkDeliveredProbe } from './application/use-cases/seller-order-mark-delivered-probe.use-case';
import { SellerOrderMarkReadyProbe } from './application/use-cases/seller-order-mark-ready-probe.use-case';
import { SellerOrderMarkUnavailableProbe } from './application/use-cases/seller-order-mark-unavailable-probe.use-case';
import { SavedFilterShareCheck } from './application/use-cases/saved-filter-share-check.use-case';
import { SellerSavedFilterCreate } from './application/use-cases/seller-saved-filter-create.use-case';
import { SellerSavedFilterDelete } from './application/use-cases/seller-saved-filter-delete.use-case';
import { SellerSavedFilterUpdate } from './application/use-cases/seller-saved-filter-update.use-case';
import { SellerSavedFiltersList } from './application/use-cases/seller-saved-filters-list.use-case';
import { AdminSavedViewsController } from './presentation/admin-saved-views.controller';
import { SellerSavedViewsController } from './presentation/seller-saved-views.controller';
import { AdminRefundOrder } from './application/use-cases/admin-refund-order.use-case';
import { AdminCancelOrder } from './application/use-cases/admin-cancel-order.use-case';
import { AdminAddOrderNote } from './application/use-cases/admin-add-order-note.use-case';
import { AdminListOrderNotes } from './application/use-cases/admin-list-order-notes.use-case';
import type { AdminNoteDependencies } from './application/admin-note-flow';
import type { SellerNoteDependencies } from './application/seller-note-flow';
import {
  SELLER_NOTE_CIPHER,
  SELLER_ORDER_NOTE_REPOSITORY,
} from './application/ports/seller-order-notes';
import { SellerAddOrderNote } from './application/use-cases/seller-add-order-note.use-case';
import { SellerListOrderNotes } from './application/use-cases/seller-list-order-notes.use-case';
import { AdminViewOrderActivity } from './application/use-cases/admin-view-order-activity.use-case';
import { SellerViewOrderActivity } from './application/use-cases/seller-view-order-activity.use-case';
import {
  ADMIN_NOTE_CIPHER,
  ADMIN_ORDER_NOTE_REPOSITORY,
} from './application/ports/admin-order-notes';
import { AdminRemoveRefundLimit } from './application/use-cases/admin-remove-refund-limit.use-case';
import { AdminSetRefundLimit } from './application/use-cases/admin-set-refund-limit.use-case';
import { AdminViewRefundLimits } from './application/use-cases/admin-view-refund-limits.use-case';
import { SettleRefunds } from './application/use-cases/settle-refunds.use-case';
import { SettleStaleRedemptions } from './application/use-cases/settle-stale-redemptions.use-case';
import { AdminExportOrders } from './application/use-cases/admin-export-orders.use-case';
import { AdminListOrders } from './application/use-cases/admin-list-orders.use-case';
import { SellerExportOrders } from './application/use-cases/seller-export-orders.use-case';
import { AdminViewOrder } from './application/use-cases/admin-view-order.use-case';
import { AdminViewOrderDocument } from './application/use-cases/admin-view-order-document.use-case';
import { CancelPayment } from './application/use-cases/cancel-payment.use-case';
import { ConfirmPayment } from './application/use-cases/confirm-payment.use-case';
import { SellerHealthCountsQuery } from './application/use-cases/seller-health-counts.use-case';
import { MyDeliveredSellerOrders } from './application/use-cases/my-delivered-seller-orders.use-case';
import { SellerOrderCustomerNames } from './application/use-cases/seller-order-customer-names.use-case';
import { RefundNoticeQuery } from './application/use-cases/refund-notice.use-case';
import { ShipmentNoticeQuery } from './application/use-cases/shipment-notice.use-case';
import { BookCarrierDeliveries } from './application/use-cases/book-carrier-deliveries.use-case';
import { RecordCarrierProgress } from './application/use-cases/record-carrier-progress.use-case';
import { RecordDeliveryAnchor } from './application/use-cases/record-delivery-anchor.use-case';
import { CancelCarrierAfterRefund } from './application/use-cases/cancel-carrier-after-refund.use-case';
import { AdminOpenObligationsOfQuery } from './application/use-cases/admin-open-obligations-of.use-case';
import { OpenObligationsOfQuery } from './application/use-cases/open-obligations-of.use-case';
import { OwnOpenObligationsQuery } from './application/use-cases/own-open-obligations.use-case';
import { CustomerOrderAccountsQuery } from './application/use-cases/customer-order-accounts.use-case';
import { CustomerOrderStatsQuery } from './application/use-cases/customer-order-stats.use-case';
import { CustomerSellerStatsQuery } from './application/use-cases/customer-seller-stats.use-case';
import { SellerCustomerOrdersQuery } from './application/use-cases/seller-customer-orders.use-case';
import { OrderNoticeQuery } from './application/use-cases/order-notice.use-case';
import { OrderPaymentRefQuery } from './application/use-cases/order-payment-ref.use-case';
import { ListOrders } from './application/use-cases/list-orders.use-case';
import { RecordLedger } from './application/use-cases/record-ledger.use-case';
import { RecordRefundLedger } from './application/use-cases/record-refund-ledger.use-case';
import { RecordShipments } from './application/use-cases/record-shipments.use-case';
import { RegeneratePickupCode } from './application/use-cases/regenerate-pickup-code.use-case';
import { SellerConfirmPickup } from './application/use-cases/seller-confirm-pickup.use-case';
import { SellerDeliverOrder } from './application/use-cases/seller-deliver-order.use-case';
import { SellerListOrders } from './application/use-cases/seller-list-orders.use-case';
import { SellerMarkOrderReady } from './application/use-cases/seller-mark-order-ready.use-case';
import { SellerMarkUnavailable } from './application/use-cases/seller-mark-unavailable.use-case';
import { BookReadyCarrierDelivery } from './application/use-cases/book-ready-carrier-delivery.use-case';
import { SellerViewOrder } from './application/use-cases/seller-view-order.use-case';
import { SellerViewOrderDocument } from './application/use-cases/seller-view-order-document.use-case';
import { DeliveryQuotes } from './application/use-cases/delivery-quotes.use-case';
import { PayByCard } from './application/use-cases/pay-by-card.use-case';
import { StartCheckout } from './application/use-cases/start-checkout.use-case';
import { ViewOrder } from './application/use-cases/view-order.use-case';
import { ViewOrderDocument } from './application/use-cases/view-order-document.use-case';
import { ORDERING_FACADE, ORDERING_PERMISSIONS, ORDERING_RANKING_FACADE } from './contracts';
import { OFFER_PAIR_STORE } from './application/ports/offer-pairs.store';
import {
  BoughtTogetherQuery,
  type BoughtTogetherDependencies,
} from './application/use-cases/bought-together.use-case';
import {
  RebuildOfferPairs,
  type RebuildOfferPairsDependencies,
} from './application/use-cases/rebuild-offer-pairs.use-case';
import { rebuildOfferPairsJob } from './presentation/jobs/rebuild-offer-pairs.job';
import { SALES_RANKING_READER } from './application/ports/sales-ranking.reader';
import {
  BestSellingOffersQuery,
  type BestSellingOffersDependencies,
} from './application/use-cases/best-selling-offers.use-case';
import { OrderingRankingFacadeImplementation } from './presentation/ordering-ranking.facade';
import { ORDERING_AUDIT_ACTIONS } from './domain/audit';
import { ORDERING_EVENTS } from './domain/events';
import { orderingProviders } from './infrastructure/ordering-providers';
import { AdminOrdersController } from './presentation/admin-orders.controller';
import { recordLedgerJob } from './presentation/jobs/record-ledger.job';
import { recordRefundLedgerJob } from './presentation/jobs/record-refund-ledger.job';
import { recordShipmentsJob } from './presentation/jobs/record-shipments.job';
import { settleRefundsJob } from './presentation/jobs/settle-refunds.job';
import { settleStaleRedemptionsJob } from './presentation/jobs/settle-stale-redemptions.job';
import { OrdersController } from './presentation/orders.controller';
import { SellerOrdersController } from './presentation/seller-orders.controller';
import { AdminCustomerRefundsController } from './presentation/admin-customer-refunds.controller';
import { AdminCustomerRefunds } from './application/use-cases/admin-customer-refunds.use-case';
import { AdminRefundLimitsController } from './presentation/admin-refund-limits.controller';
import { OrderingFacadeImplementation } from './presentation/ordering.facade';
import { carrierSubscriptions } from './presentation/subscribers/carrier.subscriptions';
import { deliverySubscriptions } from './presentation/subscribers/delivery.subscriptions';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: OrderingDependencies) => U;

const PORTS: readonly [keyof OrderingDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['orders', ORDER_REPOSITORY],
  ['refunds', REFUND_REPOSITORY],
  ['gateway', CHECKOUT_GATEWAY],
  ['policy', ORDERING_POLICY],
  ['cart', CART_CHECKOUT_FACADE],
  ['customers', CUSTOMERS_CHECKOUT_FACADE],
  ['shipTo', SHIP_TO_CIPHER],
  ['inventory', INVENTORY_ORDERING_PORT],
  ['shipping', SHIPPING_FACADE],
  ['commission', COMMISSION_PAYOUTS_FACADE],
  ['tax', TAX_FACADE],
  ['taxCategories', ORDER_TAX_CATEGORIES],
  ['products', ORDER_PRODUCTS],
  ['promotions', PROMOTIONS_FACADE],
  ['outbox', OUTBOX_WRITER],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['labels', ORDER_LABELS],
  ['deliveryMethods', DELIVERY_METHOD_POLICY],
  ['pickupCodes', PICKUP_CODE_REPOSITORY],
  ['pickupVault', PICKUP_CODE_VAULT],
  ['attempts', PAYMENT_ATTEMPT_LIMITS],
];

type ShipToRetentionUseCaseClass<U> = new (
  gate: UseCaseGate,
  deps: ShipToRetentionDependencies,
) => U;

/** The ship-to retention use cases (owner decision 2026-11-15): their own, smaller dependency set. */
function shipToRetentionProvider<U>(type: ShipToRetentionUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      SHIP_TO_RETENTION_REPOSITORY,
      MARKET_ZONES,
      AUDIT_WRITER,
      STEP_UP_CONSUMER,
      CLOCK,
      ID_GENERATOR,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: ShipToRetentionDependencies['unitOfWork'],
      retention: ShipToRetentionDependencies['retention'],
      zones: ShipToRetentionDependencies['zones'],
      audit: ShipToRetentionDependencies['audit'],
      stepUp: ShipToRetentionDependencies['stepUp'],
      clock: ShipToRetentionDependencies['clock'],
      ids: ShipToRetentionDependencies['ids'],
    ) => new type(gate, { unitOfWork, retention, zones, audit, stepUp, clock, ids }),
  };
}

type SavedViewUseCaseClass<U> = new (gate: UseCaseGate, deps: SavedViewDependencies) => U;

/** The saved-filter and list-column use cases: their own, smaller dependency set. */
function savedViewProvider<U>(
  type: SavedViewUseCaseClass<U>,
  withShareCheck: boolean,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      SAVED_FILTER_REPOSITORY,
      AUDIT_WRITER,
      CLOCK,
      ID_GENERATOR,
      SavedFilterShareCheck,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: SavedViewDependencies['unitOfWork'],
      savedFilters: SavedViewDependencies['savedFilters'],
      audit: SavedViewDependencies['audit'],
      clock: SavedViewDependencies['clock'],
      ids: SavedViewDependencies['ids'],
      shareCheck: SavedFilterShareCheck,
    ) =>
      new type(gate, {
        unitOfWork,
        savedFilters,
        audit,
        clock,
        ids,
        shareCheck: withShareCheck ? shareCheck : null,
      }),
  };
}

/** Every ordering use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as OrderingDependencies,
      ),
  };
}

/**
 * Ordering (docs/design/domain/ordering.md, simplified for speed mode; Phase 5 package 1): the
 * customer's cart becomes an order with its seller split and a hosted Stripe Checkout page. The
 * stock is reserved before the page opens and committed before the money is captured; the
 * payment webhook (package 2) reaches the order through `ORDERING_FACADE` only. Delivery models,
 * package 5: the delivery price of each seller order is the courier's live quote plus the Market
 * margin (from `shipping`), stored and bound to the order, and Package 4: the seller records the
 * shipment and the delivery of a paid order; a worker job tells inventory about each shipment.
 * Package 5: the commission rate (from `commission-payouts`) is frozen on each order line at
 * checkout, and a worker job writes each paid seller order into the seller ledger. Tax: the tax
 * of each line (from `tax`, ADR-0039) is frozen on it at checkout, added to the charge when the
 * price excludes it, and shown on the admin order page. Customers package 2: the customer picks
 * an address of their address book at checkout; a fixed copy, sealed under the account's key, is
 * stored on the order and shown to the customer and to each seller of the order. Storefront
 * reads: the best-selling Offers (ids only) through `ORDERING_RANKING_FACADE`. Tax step 3: an
 * admin refunds part or all of a paid seller order, with the tax reversed by `tax` and a credit
 * note, behind the Market switch `tax.refundCredit.enabled` (off), Stripe test mode only, each
 * request and outcome audited; a worker job settles refunds whose Stripe answer is not final.
 * Tax step 4: the customer, the seller and an admin read the order document of a paid order,
 * built from frozen values: an order confirmation while `tax.invoice.enabled` is off.
 */
@Module({
  imports: [
    ListsModule,
    CartModule,
    CatalogModule,
    CustomersModule,
    IdentityModule,
    InventoryModule,
    SellersModule,
    ShippingModule,
    CommissionPayoutsModule,
    PromotionsModule,
    TaxModule,
  ],
  controllers: [
    OrdersController,
    AdminOrdersController,
    AdminRefundLimitsController,
    AdminCustomerRefundsController,
    AdminShipToRetentionController,
    AdminShipmentsController,
    AdminDocumentsController,
    AdminRefundsController,
    SellerOrdersController,
    AdminSavedViewsController,
    SellerSavedViewsController,
  ],
  providers: [
    PersistenceModule.outboxWriterFor('ordering'),
    PersistenceModule.auditWriterFor('ordering'),
    registerAuditActions('ordering', ORDERING_AUDIT_ACTIONS),
    registerLists('ordering', ORDERING_LISTS),
    registerEvents('ordering', ORDERING_EVENTS),
    // SHP-02/03: the real-time carrier's booking and progress (ordering.inbox).
    registerSubscriptionsFrom(
      'ordering',
      [
        BookCarrierDeliveries,
        BookReadyCarrierDelivery,
        RecordCarrierProgress,
        CancelCarrierAfterRefund,
      ],
      (
        book: BookCarrierDeliveries,
        bookReady: BookReadyCarrierDelivery,
        record: RecordCarrierProgress,
        cancel: CancelCarrierAfterRefund,
      ) => carrierSubscriptions(book, bookReady, record, cancel),
    ),
    // Payout eligibility (package 6b): a delivered seller order's facts go to commission-payouts.
    registerSubscriptionsFrom('ordering', [RecordDeliveryAnchor], (record: RecordDeliveryAnchor) =>
      deliverySubscriptions(record),
    ),
    registerPermissions('ordering', ORDERING_PERMISSIONS),
    registerStepUpActions('ordering', ORDERING_STEP_UP_ACTIONS),
    ...[AdminViewShipToRetention, AdminSetShipToRetention, PurgeSettledShipTo].map((type) =>
      shipToRetentionProvider(type as ShipToRetentionUseCaseClass<unknown>),
    ),
    SubjectRateLimits,
    ...orderingProviders,
    ...[
      StartCheckout,
      PayByCard,
      DeliveryQuotes,
      ViewOrder,
      ViewOrderDocument,
      ListOrders,
      AdminViewOrder,
      AdminViewOrderActivity,
      AdminViewOrderDocument,
      AdminExportOrders,
      SellerExportOrders,
      ConfirmPayment,
      CancelPayment,
      SellerViewOrder,
      SellerViewOrderActivity,
      SellerViewOrderDocument,
      SellerMarkOrderReady,
      SellerMarkUnavailable,
      SellerConfirmPickup,
      RegeneratePickupCode,
      SellerDeliverOrder,
      RecordShipments,
      RecordLedger,
      RecordRefundLedger,
      OrderNoticeQuery,
      CustomerOrderStatsQuery,
      CustomerOrderAccountsQuery,
      CustomerSellerStatsQuery,
      SellerCustomerOrdersQuery,
      OrderPaymentRefQuery,
      ShipmentNoticeQuery,
      RefundNoticeQuery,
      SellerOrderCustomerNames,
      OwnOpenObligationsQuery,
      OpenObligationsOfQuery,
      AdminOpenObligationsOfQuery,
      MyDeliveredSellerOrders,
      SellerHealthCountsQuery,
      BookCarrierDeliveries,
      BookReadyCarrierDelivery,
      RecordCarrierProgress,
      CancelCarrierAfterRefund,
      RecordDeliveryAnchor,
      AdminRefundOrder,
      AdminCancelOrder,
      AdminViewRefundLimits,
      AdminCustomerRefunds,
      AdminSetRefundLimit,
      AdminRemoveRefundLimit,
      SettleRefunds,
      SettleStaleRedemptions,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: AdminListShipments,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, ADMIN_SHIPMENT_LIST_READER, ORDER_LABELS],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        shipments: AdminShipmentListReader,
        labels: OrderLabels,
      ) => new AdminListShipments(gate, { unitOfWork, shipments, labels }),
    },
    {
      provide: AdminListDocuments,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, ADMIN_DOCUMENT_LIST_READER, ORDER_LABELS],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        documents: AdminDocumentListReader,
        labels: OrderLabels,
      ) => new AdminListDocuments(gate, { unitOfWork, documents, labels }),
    },
    {
      provide: AdminListRefunds,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, ADMIN_REFUND_LIST_READER, ORDER_LABELS],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        refunds: AdminRefundListReader,
        labels: OrderLabels,
      ) => new AdminListRefunds(gate, { unitOfWork, refunds, labels }),
    },
    ...[AdminListOrderNotes, AdminAddOrderNote].map((type) => ({
      provide: type,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        ADMIN_ORDER_NOTE_REPOSITORY,
        ADMIN_NOTE_CIPHER,
        AUDIT_WRITER,
        ID_GENERATOR,
        CLOCK,
        ORDER_LABELS,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: AdminNoteDependencies['unitOfWork'],
        notes: AdminNoteDependencies['notes'],
        cipher: AdminNoteDependencies['cipher'],
        audit: AdminNoteDependencies['audit'],
        ids: AdminNoteDependencies['ids'],
        clock: AdminNoteDependencies['clock'],
        labels: AdminNoteDependencies['labels'],
      ) => new type(gate, { unitOfWork, notes, cipher, audit, ids, clock, labels }),
    })),
    ...[SellerListOrderNotes, SellerAddOrderNote].map((type) => ({
      provide: type,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        SELLER_ORDER_NOTE_REPOSITORY,
        SELLER_NOTE_CIPHER,
        AUDIT_WRITER,
        ID_GENERATOR,
        CLOCK,
        ORDER_LABELS,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: SellerNoteDependencies['unitOfWork'],
        notes: SellerNoteDependencies['notes'],
        cipher: SellerNoteDependencies['cipher'],
        audit: SellerNoteDependencies['audit'],
        ids: SellerNoteDependencies['ids'],
        clock: SellerNoteDependencies['clock'],
        labels: SellerNoteDependencies['labels'],
      ) => new type(gate, { unitOfWork, notes, cipher, audit, ids, clock, labels }),
    })),
    // The order lists name each row's actions from probes of the caller's keys (super list phase 1).
    ...[
      OrderRefundProbe,
      OrderNoteProbe,
      SellerOrderMarkReadyProbe,
      SellerOrderConfirmPickupProbe,
      SellerOrderMarkDeliveredProbe,
      SellerOrderMarkUnavailableProbe,
    ].map((type) => ({
      provide: type,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate) => new type(gate),
    })),
    {
      provide: AdminListOrders,
      inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token), OrderRefundProbe, OrderNoteProbe],
      useFactory: (gate: UseCaseGate, ...values: unknown[]) => {
        const probes = values.slice(PORTS.length);
        return new AdminListOrders(
          gate,
          Object.fromEntries(
            PORTS.map(([name], index) => [name, values[index]]),
          ) as unknown as OrderingDependencies,
          { refundProbe: probes[0] as OrderRefundProbe, noteProbe: probes[1] as OrderNoteProbe },
        );
      },
    },
    {
      provide: SellerListOrders,
      inject: [
        USE_CASE_GATE,
        ...PORTS.map(([, token]) => token),
        SellerOrderMarkReadyProbe,
        SellerOrderConfirmPickupProbe,
        SellerOrderMarkDeliveredProbe,
        SellerOrderMarkUnavailableProbe,
      ],
      useFactory: (gate: UseCaseGate, ...values: unknown[]) => {
        const probes = values.slice(PORTS.length);
        return new SellerListOrders(
          gate,
          Object.fromEntries(
            PORTS.map(([name], index) => [name, values[index]]),
          ) as unknown as OrderingDependencies,
          {
            markReadyProbe: probes[0] as SellerOrderMarkReadyProbe,
            confirmPickupProbe: probes[1] as SellerOrderConfirmPickupProbe,
            markDeliveredProbe: probes[2] as SellerOrderMarkDeliveredProbe,
            markUnavailableProbe: probes[3] as SellerOrderMarkUnavailableProbe,
          },
        );
      },
    },
    {
      provide: SavedFilterShareCheck,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate): SavedFilterShareCheck => new SavedFilterShareCheck(gate),
    },
    ...[
      AdminSavedFiltersList,
      AdminSavedFilterCreate,
      AdminSavedFilterUpdate,
      AdminSavedFilterDelete,
    ].map((type) => savedViewProvider(type as SavedViewUseCaseClass<unknown>, true)),
    ...[
      SellerSavedFiltersList,
      SellerSavedFilterCreate,
      SellerSavedFilterUpdate,
      SellerSavedFilterDelete,
    ].map((type) => savedViewProvider(type as SavedViewUseCaseClass<unknown>, false)),
    {
      provide: ORDERING_FACADE,
      inject: [
        ConfirmPayment,
        CancelPayment,
        OrderNoticeQuery,
        ShipmentNoticeQuery,
        SellerOrderCustomerNames,
        OwnOpenObligationsQuery,
        OpenObligationsOfQuery,
        MyDeliveredSellerOrders,
        OrderPaymentRefQuery,
        AdminOpenObligationsOfQuery,
        SellerHealthCountsQuery,
        RefundNoticeQuery,
        CustomerOrderStatsQuery,
        CustomerOrderAccountsQuery,
        CustomerSellerStatsQuery,
        SellerCustomerOrdersQuery,
      ],
      useFactory: (
        confirm: ConfirmPayment,
        cancel: CancelPayment,
        notice: OrderNoticeQuery,
        shipment: ShipmentNoticeQuery,
        customerNames: SellerOrderCustomerNames,
        openObligations: OwnOpenObligationsQuery,
        openObligationsOfAccount: OpenObligationsOfQuery,
        delivered: MyDeliveredSellerOrders,
        paymentRef: OrderPaymentRefQuery,
        adminOpenObligations: AdminOpenObligationsOfQuery,
        healthCounts: SellerHealthCountsQuery,
        refundNotice: RefundNoticeQuery,
        customerStats: CustomerOrderStatsQuery,
        customerAccounts: CustomerOrderAccountsQuery,
        customerSellers: CustomerSellerStatsQuery,
        sellerCustomerOrders: SellerCustomerOrdersQuery,
      ) =>
        new OrderingFacadeImplementation(
          confirm,
          cancel,
          notice,
          shipment,
          customerNames,
          openObligations,
          openObligationsOfAccount,
          delivered,
          paymentRef,
          adminOpenObligations,
          healthCounts,
          refundNotice,
          customerStats,
          customerAccounts,
          customerSellers,
          sellerCustomerOrders,
        ),
    },
    {
      provide: BestSellingOffersQuery,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, SALES_RANKING_READER, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: BestSellingOffersDependencies['unitOfWork'],
        ranking: BestSellingOffersDependencies['ranking'],
        clock: BestSellingOffersDependencies['clock'],
      ) => new BestSellingOffersQuery(gate, { unitOfWork, ranking, clock }),
    },
    {
      provide: BoughtTogetherQuery,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, OFFER_PAIR_STORE],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: BoughtTogetherDependencies['unitOfWork'],
        pairs: BoughtTogetherDependencies['pairs'],
      ) => new BoughtTogetherQuery(gate, { unitOfWork, pairs }),
    },
    {
      provide: RebuildOfferPairs,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, OFFER_PAIR_STORE, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: RebuildOfferPairsDependencies['unitOfWork'],
        pairs: RebuildOfferPairsDependencies['pairs'],
        clock: RebuildOfferPairsDependencies['clock'],
      ) => new RebuildOfferPairs(gate, { unitOfWork, pairs, clock }),
    },
    {
      provide: ORDERING_RANKING_FACADE,
      inject: [BestSellingOffersQuery, BoughtTogetherQuery],
      useFactory: (bestSelling: BestSellingOffersQuery, boughtTogether: BoughtTogetherQuery) =>
        new OrderingRankingFacadeImplementation(bestSelling, boughtTogether),
    },
    registerJobsFrom(
      'ordering',
      [
        RecordShipments,
        RecordLedger,
        RecordRefundLedger,
        SettleRefunds,
        RebuildOfferPairs,
        PurgeSettledShipTo,
        SettleStaleRedemptions,
      ],
      (
        shipments: RecordShipments,
        ledger: RecordLedger,
        refundLedger: RecordRefundLedger,
        refunds: SettleRefunds,
        pairs: RebuildOfferPairs,
        purgeShipTo: PurgeSettledShipTo,
        staleRedemptions: SettleStaleRedemptions,
      ) => [
        recordShipmentsJob(shipments),
        recordLedgerJob(ledger),
        recordRefundLedgerJob(refundLedger),
        settleRefundsJob(refunds),
        rebuildOfferPairsJob(pairs),
        purgeSettledShipToJob(purgeShipTo),
        settleStaleRedemptionsJob(staleRedemptions),
      ],
    ),
  ],
  exports: [ORDERING_FACADE, ORDERING_RANKING_FACADE],
})
export class OrderingModule {}
