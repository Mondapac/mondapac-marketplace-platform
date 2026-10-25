import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CART_CHECKOUT_FACADE, CartModule } from '../cart';
import { CatalogModule } from '../catalog';
import { COMMISSION_PAYOUTS_FACADE, CommissionPayoutsModule } from '../commission-payouts';
import { CUSTOMERS_CHECKOUT_FACADE, CustomersModule } from '../customers';
import { IdentityModule } from '../identity';
import { InventoryModule } from '../inventory';
import { INVENTORY_ORDERING_PORT } from '../inventory/contracts/ordering-port';
import { SellersModule } from '../sellers';
import { SHIPPING_FACADE, ShippingModule } from '../shipping';
import { TAX_FACADE, TaxModule } from '../tax';
import type { OrderingDependencies } from './application/checkout-flow';
import { CHECKOUT_GATEWAY } from './application/ports/checkout-gateway';
import { ORDER_LABELS } from './application/ports/order-labels';
import { ORDER_TAX_CATEGORIES } from './application/ports/order-tax-categories';
import { ORDER_REPOSITORY } from './application/ports/order.repository';
import { REFUND_REPOSITORY } from './application/ports/refund.repository';
import { ORDERING_POLICY } from './application/ports/ordering-policy';
import { SHIP_TO_CIPHER } from './application/ports/ship-to-cipher';
import { AdminRefundOrder } from './application/use-cases/admin-refund-order.use-case';
import { SettleRefunds } from './application/use-cases/settle-refunds.use-case';
import { AdminListOrders } from './application/use-cases/admin-list-orders.use-case';
import { AdminViewOrder } from './application/use-cases/admin-view-order.use-case';
import { AdminViewOrderDocument } from './application/use-cases/admin-view-order-document.use-case';
import { CancelPayment } from './application/use-cases/cancel-payment.use-case';
import { ConfirmPayment } from './application/use-cases/confirm-payment.use-case';
import { SellerOrderCustomerNames } from './application/use-cases/seller-order-customer-names.use-case';
import { ShipmentNoticeQuery } from './application/use-cases/shipment-notice.use-case';
import { BookCarrierDeliveries } from './application/use-cases/book-carrier-deliveries.use-case';
import { RecordCarrierProgress } from './application/use-cases/record-carrier-progress.use-case';
import { CancelCarrierAfterRefund } from './application/use-cases/cancel-carrier-after-refund.use-case';
import { OrderNoticeQuery } from './application/use-cases/order-notice.use-case';
import { ListOrders } from './application/use-cases/list-orders.use-case';
import { RecordLedger } from './application/use-cases/record-ledger.use-case';
import { RecordRefundLedger } from './application/use-cases/record-refund-ledger.use-case';
import { RecordShipments } from './application/use-cases/record-shipments.use-case';
import { SellerDeliverOrder } from './application/use-cases/seller-deliver-order.use-case';
import { SellerListOrders } from './application/use-cases/seller-list-orders.use-case';
import { SellerShipOrder } from './application/use-cases/seller-ship-order.use-case';
import { SellerViewOrder } from './application/use-cases/seller-view-order.use-case';
import { SellerViewOrderDocument } from './application/use-cases/seller-view-order-document.use-case';
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
import { OrdersController } from './presentation/orders.controller';
import { SellerOrdersController } from './presentation/seller-orders.controller';
import { OrderingFacadeImplementation } from './presentation/ordering.facade';
import { carrierSubscriptions } from './presentation/subscribers/carrier.subscriptions';

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
  ['outbox', OUTBOX_WRITER],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['labels', ORDER_LABELS],
];

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
 * payment webhook (package 2) reaches the order through `ORDERING_FACADE` only. Package 4: each
 * seller's flat delivery fee (from `shipping`) is part of the total, and the seller records the
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
    CartModule,
    CatalogModule,
    CustomersModule,
    IdentityModule,
    InventoryModule,
    SellersModule,
    ShippingModule,
    CommissionPayoutsModule,
    TaxModule,
  ],
  controllers: [OrdersController, AdminOrdersController, SellerOrdersController],
  providers: [
    PersistenceModule.outboxWriterFor('ordering'),
    PersistenceModule.auditWriterFor('ordering'),
    registerAuditActions('ordering', ORDERING_AUDIT_ACTIONS),
    registerEvents('ordering', ORDERING_EVENTS),
    // SHP-02/03: the real-time carrier's booking and progress (ordering.inbox).
    registerSubscriptionsFrom(
      'ordering',
      [BookCarrierDeliveries, RecordCarrierProgress, CancelCarrierAfterRefund],
      (
        book: BookCarrierDeliveries,
        record: RecordCarrierProgress,
        cancel: CancelCarrierAfterRefund,
      ) => carrierSubscriptions(book, record, cancel),
    ),
    registerPermissions('ordering', ORDERING_PERMISSIONS),
    ...orderingProviders,
    ...[
      StartCheckout,
      ViewOrder,
      ViewOrderDocument,
      ListOrders,
      AdminViewOrder,
      AdminViewOrderDocument,
      AdminListOrders,
      ConfirmPayment,
      CancelPayment,
      SellerListOrders,
      SellerViewOrder,
      SellerViewOrderDocument,
      SellerShipOrder,
      SellerDeliverOrder,
      RecordShipments,
      RecordLedger,
      RecordRefundLedger,
      OrderNoticeQuery,
      ShipmentNoticeQuery,
      SellerOrderCustomerNames,
      BookCarrierDeliveries,
      RecordCarrierProgress,
      CancelCarrierAfterRefund,
      AdminRefundOrder,
      SettleRefunds,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: ORDERING_FACADE,
      inject: [
        ConfirmPayment,
        CancelPayment,
        OrderNoticeQuery,
        ShipmentNoticeQuery,
        SellerOrderCustomerNames,
      ],
      useFactory: (
        confirm: ConfirmPayment,
        cancel: CancelPayment,
        notice: OrderNoticeQuery,
        shipment: ShipmentNoticeQuery,
        customerNames: SellerOrderCustomerNames,
      ) => new OrderingFacadeImplementation(confirm, cancel, notice, shipment, customerNames),
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
      [RecordShipments, RecordLedger, RecordRefundLedger, SettleRefunds, RebuildOfferPairs],
      (
        shipments: RecordShipments,
        ledger: RecordLedger,
        refundLedger: RecordRefundLedger,
        refunds: SettleRefunds,
        pairs: RebuildOfferPairs,
      ) => [
        recordShipmentsJob(shipments),
        recordLedgerJob(ledger),
        recordRefundLedgerJob(refundLedger),
        settleRefundsJob(refunds),
        rebuildOfferPairsJob(pairs),
      ],
    ),
  ],
  exports: [ORDERING_FACADE, ORDERING_RANKING_FACADE],
})
export class OrderingModule {}
