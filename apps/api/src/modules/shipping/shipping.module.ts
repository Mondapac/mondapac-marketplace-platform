import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { SECURITY_EVENTS } from '../../platform/security-events/security-events';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { SellersModule } from '../sellers';
import { CARRIER_BOOKING_REPOSITORY } from './application/ports/carrier-booking.repository';
import { FLEET_REGISTRY } from './application/ports/fleet-registry';
import { DELIVERY_SETTINGS_REPOSITORY } from './application/ports/delivery-settings.repository';
import { FLEET_SELECTION_REPOSITORY } from './application/ports/fleet-selection.repository';
import { CARRIER_POLICY } from './application/ports/carrier-policy';
import { CARRIER_WEBHOOK_SIGNATURE } from './application/ports/carrier-webhook-signature';
import { FLAT_FEE_REPOSITORY } from './application/ports/flat-fee.repository';
import { PICKUP_DIRECTORY } from './application/ports/pickup-directory';
import { SELLER_DIRECTORY } from './application/ports/seller-directory';
import { STORE_DIRECTORY } from './application/ports/store-directory';
import { SHIPPING_POLICY } from './application/ports/shipping-policy';
import type { ShippingDependencies } from './application/shipping-dependencies';
import { DeliveryAvailability } from './application/use-cases/delivery-availability.use-case';
import { DeliveryChoice } from './application/use-cases/delivery-choice.use-case';
import { PriceDelivery } from './application/use-cases/price-delivery.use-case';
import { SetDeliverySettings } from './application/use-cases/set-delivery-settings.use-case';
import { SetSellerDeliveryMethods } from './application/use-cases/set-seller-delivery-methods.use-case';
import { ViewDeliverySettings } from './application/use-cases/view-delivery-settings.use-case';
import { ViewSellerDeliveryMethods } from './application/use-cases/view-seller-delivery-methods.use-case';
import { ActivateFleetSelectionModel } from './application/use-cases/activate-fleet-selection-model.use-case';
import { CreateFleetSelectionModel } from './application/use-cases/create-fleet-selection-model.use-case';
import { SetFleetReliability } from './application/use-cases/set-fleet-reliability.use-case';
import { UpdateFleetSelectionModel } from './application/use-cases/update-fleet-selection-model.use-case';
import { ViewFleetSelection } from './application/use-cases/view-fleet-selection.use-case';
import { BookCarrierDelivery } from './application/use-cases/book-carrier-delivery.use-case';
import { CancelCarrierDelivery } from './application/use-cases/cancel-carrier-delivery.use-case';
import { CarrierShipmentQuery } from './application/use-cases/carrier-shipment.use-case';
import { DeliveryArea } from './application/use-cases/delivery-area.use-case';
import { FlatFees } from './application/use-cases/flat-fees.use-case';
import { PickupAvailability } from './application/use-cases/pickup-availability.use-case';
import { ShippingFees } from './application/use-cases/shipping-fees.use-case';
import { ReceiveCarrierWebhook } from './application/use-cases/receive-carrier-webhook.use-case';
import { SetFlatFee } from './application/use-cases/set-flat-fee.use-case';
import { ViewFlatFee } from './application/use-cases/view-flat-fee.use-case';
import { ViewOwnFlatFee } from './application/use-cases/view-own-flat-fee.use-case';
import { ViewStoreFlatFee } from './application/use-cases/view-store-flat-fee.use-case';
import { SHIPPING_FACADE, SHIPPING_PERMISSIONS } from './contracts';
import { SHIPPING_AUDIT_ACTIONS } from './domain/audit';
import { SHIPPING_EVENTS } from './domain/events';
import { shippingProviders } from './infrastructure/shipping-providers';
import {
  AdminFlatFeeController,
  SellerFlatFeeController,
} from './presentation/flat-fee.controller';
import { CarrierWebhookController } from './presentation/carrier-webhook.controller';
import { DeliverySettingsController } from './presentation/delivery-settings.controller';
import { FleetSelectionController } from './presentation/fleet-selection.controller';
import { DeliveryAreaController } from './presentation/delivery-area.controller';
import { StoreFlatFeeController } from './presentation/store-flat-fee.controller';
import { ShippingFacadeImplementation } from './presentation/shipping.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: ShippingDependencies) => U;

const PORTS: readonly [keyof ShippingDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['fees', FLAT_FEE_REPOSITORY],
  ['policy', SHIPPING_POLICY],
  ['sellers', SELLER_DIRECTORY],
  ['stores', STORE_DIRECTORY],
  ['audit', AUDIT_WRITER],
  ['clock', CLOCK],
  ['ids', ID_GENERATOR],
  ['outbox', OUTBOX_WRITER],
  ['bookings', CARRIER_BOOKING_REPOSITORY],
  ['fleets', FLEET_REGISTRY],
  ['selection', FLEET_SELECTION_REPOSITORY],
  ['deliverySettings', DELIVERY_SETTINGS_REPOSITORY],
  ['carrierPolicy', CARRIER_POLICY],
  ['pickups', PICKUP_DIRECTORY],
  ['webhookSignature', CARRIER_WEBHOOK_SIGNATURE],
  ['securityEvents', SECURITY_EVENTS],
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
 * Delivery models, package 3: the fleet router. Each seller order is booked with the fleet the
 * router picks from the fleets that are on for the Market and can carry it, ranked by the model
 * an admin made active for the Market and the buyer's method (`FleetSelectionController`).
 * Delivery models, package 4: the delivery settings. An admin switches the delivery methods on or
 * off for the Market, sets the same-day cut-off, the scheduled days and window and the margin on a
 * fleet's quote, and gives each seller the methods it supports (`DeliverySettingsController`).
 * Shipping owns them because they decide how an order is carried and what the carrying costs;
 * ordering reads what a seller offers through the facade, and the sellers module is asked only
 * for a seller's operating zone and pickup address.
 */
@Module({
  imports: [SellersModule],
  controllers: [
    AdminFlatFeeController,
    SellerFlatFeeController,
    DeliveryAreaController,
    StoreFlatFeeController,
    CarrierWebhookController,
    FleetSelectionController,
    DeliverySettingsController,
  ],
  providers: [
    PersistenceModule.auditWriterFor('shipping'),
    PersistenceModule.securityEventsFor('shipping'),
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
      ShippingFees,
      DeliveryArea,
      PickupAvailability,
      BookCarrierDelivery,
      CarrierShipmentQuery,
      CancelCarrierDelivery,
      ReceiveCarrierWebhook,
      ViewStoreFlatFee,
      ViewFleetSelection,
      CreateFleetSelectionModel,
      UpdateFleetSelectionModel,
      ActivateFleetSelectionModel,
      SetFleetReliability,
      ViewDeliverySettings,
      SetDeliverySettings,
      ViewSellerDeliveryMethods,
      SetSellerDeliveryMethods,
      DeliveryAvailability,
      DeliveryChoice,
      PriceDelivery,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: SHIPPING_FACADE,
      inject: [
        FlatFees,
        ShippingFees,
        DeliveryArea,
        PickupAvailability,
        BookCarrierDelivery,
        CarrierShipmentQuery,
        CancelCarrierDelivery,
        DeliveryAvailability,
        DeliveryChoice,
        PriceDelivery,
      ],
      useFactory: (
        fees: FlatFees,
        shippingFees: ShippingFees,
        area: DeliveryArea,
        pickup: PickupAvailability,
        book: BookCarrierDelivery,
        shipment: CarrierShipmentQuery,
        cancel: CancelCarrierDelivery,
        availability: DeliveryAvailability,
        choice: DeliveryChoice,
        price: PriceDelivery,
      ) =>
        new ShippingFacadeImplementation({
          fees,
          shippingFees,
          area,
          pickup,
          book,
          shipment,
          cancel,
          availability,
          choice,
          price,
        }),
    },
  ],
  exports: [SHIPPING_FACADE],
})
export class ShippingModule {}
