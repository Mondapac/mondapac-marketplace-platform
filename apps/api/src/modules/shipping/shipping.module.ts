import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { SellersModule } from '../sellers';
import { CARRIER_BOOKING_REPOSITORY } from './application/ports/carrier-booking.repository';
import { CARRIER_GATEWAY } from './application/ports/carrier-gateway';
import { CARRIER_POLICY } from './application/ports/carrier-policy';
import { CARRIER_WEBHOOK_SIGNATURE } from './application/ports/carrier-webhook-signature';
import { FLAT_FEE_REPOSITORY } from './application/ports/flat-fee.repository';
import { PICKUP_DIRECTORY } from './application/ports/pickup-directory';
import { SELLER_DIRECTORY } from './application/ports/seller-directory';
import { SHIPPING_POLICY } from './application/ports/shipping-policy';
import type { ShippingDependencies } from './application/shipping-dependencies';
import { BookCarrierDelivery } from './application/use-cases/book-carrier-delivery.use-case';
import { CancelCarrierDelivery } from './application/use-cases/cancel-carrier-delivery.use-case';
import { CarrierShipmentQuery } from './application/use-cases/carrier-shipment.use-case';
import { DeliveryArea } from './application/use-cases/delivery-area.use-case';
import { FlatFees } from './application/use-cases/flat-fees.use-case';
import { ReceiveCarrierWebhook } from './application/use-cases/receive-carrier-webhook.use-case';
import { SetFlatFee } from './application/use-cases/set-flat-fee.use-case';
import { ViewFlatFee } from './application/use-cases/view-flat-fee.use-case';
import { ViewOwnFlatFee } from './application/use-cases/view-own-flat-fee.use-case';
import { SHIPPING_FACADE, SHIPPING_PERMISSIONS } from './contracts';
import { SHIPPING_AUDIT_ACTIONS } from './domain/audit';
import { SHIPPING_EVENTS } from './domain/events';
import { shippingProviders } from './infrastructure/shipping-providers';
import {
  AdminFlatFeeController,
  SellerFlatFeeController,
} from './presentation/flat-fee.controller';
import { CarrierWebhookController } from './presentation/carrier-webhook.controller';
import { DeliveryAreaController } from './presentation/delivery-area.controller';
import { ShippingFacadeImplementation } from './presentation/shipping.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: ShippingDependencies) => U;

const PORTS: readonly [keyof ShippingDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['fees', FLAT_FEE_REPOSITORY],
  ['policy', SHIPPING_POLICY],
  ['sellers', SELLER_DIRECTORY],
  ['audit', AUDIT_WRITER],
  ['clock', CLOCK],
  ['ids', ID_GENERATOR],
  ['outbox', OUTBOX_WRITER],
  ['bookings', CARRIER_BOOKING_REPOSITORY],
  ['carrier', CARRIER_GATEWAY],
  ['carrierPolicy', CARRIER_POLICY],
  ['pickups', PICKUP_DIRECTORY],
  ['webhookSignature', CARRIER_WEBHOOK_SIGNATURE],
];

/** Every shipping use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as ShippingDependencies,
      ),
  };
}

/**
 * Shipping (Phase 5 package 4, SHP-01, speed mode). The flat shipping fee of each seller: an
 * admin sets it, the seller sees it, and `ordering` reads it through `SHIPPING_FACADE` at
 * checkout (a seller without a fee cannot be bought from) and `cart` reads it for the cart page.
 * The delivery area check answers whether the Market delivers to a postcode (ServiceArea config).
 * SHP-02/03, the `real_time_delivery` FulfillmentStrategy: once an order is paid, ordering hands
 * each seller order to `bookCarrierDelivery`, which books it with the Market's real-time carrier
 * (Mondapac Drive) when the carrier is on and both ends are in its areas. Drive's signed status
 * webhooks move the booking on and publish `shipping.carrier-delivery-progressed.v1`, from which
 * ordering records the shipment and the delivery. Live carrier rates at checkout come next.
 */
@Module({
  imports: [SellersModule],
  controllers: [
    AdminFlatFeeController,
    SellerFlatFeeController,
    DeliveryAreaController,
    CarrierWebhookController,
  ],
  providers: [
    PersistenceModule.auditWriterFor('shipping'),
    registerAuditActions('shipping', SHIPPING_AUDIT_ACTIONS),
    registerPermissions('shipping', SHIPPING_PERMISSIONS),
    registerEvents('shipping', SHIPPING_EVENTS),
    PersistenceModule.outboxWriterFor('shipping'),
    ...shippingProviders,
    ...[
      SetFlatFee,
      ViewFlatFee,
      ViewOwnFlatFee,
      FlatFees,
      DeliveryArea,
      BookCarrierDelivery,
      CarrierShipmentQuery,
      CancelCarrierDelivery,
      ReceiveCarrierWebhook,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: SHIPPING_FACADE,
      inject: [
        FlatFees,
        DeliveryArea,
        BookCarrierDelivery,
        CarrierShipmentQuery,
        CancelCarrierDelivery,
      ],
      useFactory: (
        fees: FlatFees,
        area: DeliveryArea,
        book: BookCarrierDelivery,
        shipment: CarrierShipmentQuery,
        cancel: CancelCarrierDelivery,
      ) => new ShippingFacadeImplementation({ fees, area, book, shipment, cancel }),
    },
  ],
  exports: [SHIPPING_FACADE],
})
export class ShippingModule {}
