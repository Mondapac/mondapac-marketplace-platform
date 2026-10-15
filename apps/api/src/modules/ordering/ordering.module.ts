import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CART_CHECKOUT_FACADE, CartModule } from '../cart';
import { COMMISSION_PAYOUTS_FACADE, CommissionPayoutsModule } from '../commission-payouts';
import { InventoryModule } from '../inventory';
import { INVENTORY_ORDERING_PORT } from '../inventory/contracts/ordering-port';
import { SHIPPING_FACADE, ShippingModule } from '../shipping';
import type { OrderingDependencies } from './application/checkout-flow';
import { CHECKOUT_GATEWAY } from './application/ports/checkout-gateway';
import { ORDER_REPOSITORY } from './application/ports/order.repository';
import { ORDERING_POLICY } from './application/ports/ordering-policy';
import { AdminListOrders } from './application/use-cases/admin-list-orders.use-case';
import { AdminViewOrder } from './application/use-cases/admin-view-order.use-case';
import { CancelPayment } from './application/use-cases/cancel-payment.use-case';
import { ConfirmPayment } from './application/use-cases/confirm-payment.use-case';
import { OrderNoticeQuery } from './application/use-cases/order-notice.use-case';
import { ListOrders } from './application/use-cases/list-orders.use-case';
import { RecordLedger } from './application/use-cases/record-ledger.use-case';
import { RecordShipments } from './application/use-cases/record-shipments.use-case';
import { SellerDeliverOrder } from './application/use-cases/seller-deliver-order.use-case';
import { SellerListOrders } from './application/use-cases/seller-list-orders.use-case';
import { SellerShipOrder } from './application/use-cases/seller-ship-order.use-case';
import { SellerViewOrder } from './application/use-cases/seller-view-order.use-case';
import { StartCheckout } from './application/use-cases/start-checkout.use-case';
import { ViewOrder } from './application/use-cases/view-order.use-case';
import { ORDERING_FACADE, ORDERING_PERMISSIONS } from './contracts';
import { ORDERING_EVENTS } from './domain/events';
import { orderingProviders } from './infrastructure/ordering-providers';
import { AdminOrdersController } from './presentation/admin-orders.controller';
import { recordLedgerJob } from './presentation/jobs/record-ledger.job';
import { recordShipmentsJob } from './presentation/jobs/record-shipments.job';
import { OrdersController } from './presentation/orders.controller';
import { SellerOrdersController } from './presentation/seller-orders.controller';
import { OrderingFacadeImplementation } from './presentation/ordering.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: OrderingDependencies) => U;

const PORTS: readonly [keyof OrderingDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['orders', ORDER_REPOSITORY],
  ['gateway', CHECKOUT_GATEWAY],
  ['policy', ORDERING_POLICY],
  ['cart', CART_CHECKOUT_FACADE],
  ['inventory', INVENTORY_ORDERING_PORT],
  ['shipping', SHIPPING_FACADE],
  ['commission', COMMISSION_PAYOUTS_FACADE],
  ['outbox', OUTBOX_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
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
 * checkout, and a worker job writes each paid seller order into the seller ledger.
 */
@Module({
  imports: [CartModule, InventoryModule, ShippingModule, CommissionPayoutsModule],
  controllers: [OrdersController, AdminOrdersController, SellerOrdersController],
  providers: [
    PersistenceModule.outboxWriterFor('ordering'),
    registerEvents('ordering', ORDERING_EVENTS),
    registerPermissions('ordering', ORDERING_PERMISSIONS),
    ...orderingProviders,
    ...[
      StartCheckout,
      ViewOrder,
      ListOrders,
      AdminViewOrder,
      AdminListOrders,
      ConfirmPayment,
      CancelPayment,
      SellerListOrders,
      SellerViewOrder,
      SellerShipOrder,
      SellerDeliverOrder,
      RecordShipments,
      RecordLedger,
      OrderNoticeQuery,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: ORDERING_FACADE,
      inject: [ConfirmPayment, CancelPayment, OrderNoticeQuery],
      useFactory: (confirm: ConfirmPayment, cancel: CancelPayment, notice: OrderNoticeQuery) =>
        new OrderingFacadeImplementation(confirm, cancel, notice),
    },
    registerJobsFrom(
      'ordering',
      [RecordShipments, RecordLedger],
      (shipments: RecordShipments, ledger: RecordLedger) => [
        recordShipmentsJob(shipments),
        recordLedgerJob(ledger),
      ],
    ),
  ],
  exports: [ORDERING_FACADE],
})
export class OrderingModule {}
