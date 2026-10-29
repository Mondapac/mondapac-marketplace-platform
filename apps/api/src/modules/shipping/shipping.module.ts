import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
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
import { DELIVERY_QUOTE_REPOSITORY } from './application/ports/delivery-quote.repository';
import { FLEET_LEDGER_REPOSITORY } from './application/ports/fleet-ledger.repository';
import { UBER_WEBHOOK_SIGNATURE } from './application/ports/fleet-webhook-signature';
import { PICKUP_DIRECTORY } from './application/ports/pickup-directory';
import { SELLER_DIRECTORY } from './application/ports/seller-directory';
import { SHIPPING_POLICY } from './application/ports/shipping-policy';
import type { ShippingDependencies } from './application/shipping-dependencies';
import { DeliveryAvailability } from './application/use-cases/delivery-availability.use-case';
import { DeliveryChoice } from './application/use-cases/delivery-choice.use-case';
import { ChargeDelivery } from './application/use-cases/charge-delivery.use-case';
import { PriceDelivery } from './application/use-cases/price-delivery.use-case';
import { QuoteDeliveries } from './application/use-cases/quote-deliveries.use-case';
import { RecordFleetFee } from './application/use-cases/record-fleet-fee.use-case';
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
import { CarrierTrackingLinks } from './application/use-cases/carrier-tracking-links.use-case';
import { CarrierShipmentQuery } from './application/use-cases/carrier-shipment.use-case';
import { DeliveryArea } from './application/use-cases/delivery-area.use-case';
import { PickupAvailability } from './application/use-cases/pickup-availability.use-case';
import { PollFleetStatus } from './application/use-cases/poll-fleet-status.use-case';
import { ReceiveUberWebhook } from './application/use-cases/receive-uber-webhook.use-case';
import { ReceiveCarrierWebhook } from './application/use-cases/receive-carrier-webhook.use-case';
import { SHIPPING_FACADE, SHIPPING_PERMISSIONS } from './contracts';
import { SHIPPING_AUDIT_ACTIONS } from './domain/audit';
import { SHIPPING_EVENTS } from './domain/events';
import { shippingProviders } from './infrastructure/shipping-providers';
import { pollFleetStatusJob } from './presentation/jobs/poll-fleet-status.job';
import { UberWebhookController } from './presentation/uber-webhook.controller';
import { CarrierWebhookController } from './presentation/carrier-webhook.controller';
import { DeliverySettingsController } from './presentation/delivery-settings.controller';
import { FleetSelectionController } from './presentation/fleet-selection.controller';
import { DeliveryAreaController } from './presentation/delivery-area.controller';
import { ShippingFacadeImplementation } from './presentation/shipping.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: ShippingDependencies) => U;

const PORTS: readonly [keyof ShippingDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['policy', SHIPPING_POLICY],
  ['sellers', SELLER_DIRECTORY],
  ['audit', AUDIT_WRITER],
  ['clock', CLOCK],
  ['ids', ID_GENERATOR],
  ['outbox', OUTBOX_WRITER],
  ['bookings', CARRIER_BOOKING_REPOSITORY],
  ['fleets', FLEET_REGISTRY],
  ['selection', FLEET_SELECTION_REPOSITORY],
  ['deliverySettings', DELIVERY_SETTINGS_REPOSITORY],
  ['carrierPolicy', CARRIER_POLICY],
  ['quotes', DELIVERY_QUOTE_REPOSITORY],
  ['ledger', FLEET_LEDGER_REPOSITORY],
  ['pickups', PICKUP_DIRECTORY],
  ['webhookSignature', CARRIER_WEBHOOK_SIGNATURE],
  ['uberWebhookSignature', UBER_WEBHOOK_SIGNATURE],
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
 * Shipping. The delivery area check answers whether the Market delivers to a postcode (ServiceArea
 * config). SHP-02/03, the `real_time_delivery` FulfillmentStrategy: ordering hands each paid seller
 * order to `bookCarrierDelivery`, which books it with the fleet the router picks. Delivery models,
 * package 3: the fleet router, ranked by the model an admin made active for the Market and the
 * buyer's method (`FleetSelectionController`). Package 4: the delivery settings an admin sets for
 * the Market and for each seller (`DeliverySettingsController`). Package 5: the buyer pays the
 * fleet's live quote plus the Market's margin (`quoteDeliveries`, `chargeDelivery`), a booking that
 * replaces the charged fleet is absorbed up to the Market's cap, and the fees fleets charge the
 * platform are recorded in a ledger (`recordFleetFee`). The seller sets no delivery fee or window:
 * the seller flat fee was removed with this package. Drive's signed status webhooks move a booking
 * on and publish `shipping.carrier-delivery-progressed.v1`, from which ordering records the
 * shipment and the delivery. Ordering reads what a seller offers and what a delivery costs through
 * the facade; the sellers module is asked only for a seller's operating zone and pickup address.
 */
@Module({
  imports: [SellersModule],
  controllers: [
    DeliveryAreaController,
    CarrierWebhookController,
    UberWebhookController,
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
    registerJobsFrom('shipping', [PollFleetStatus], (poll: PollFleetStatus) => [
      pollFleetStatusJob(poll),
    ]),
    ...[
      DeliveryArea,
      PickupAvailability,
      BookCarrierDelivery,
      CarrierShipmentQuery,
      CarrierTrackingLinks,
      CancelCarrierDelivery,
      ReceiveCarrierWebhook,
      ReceiveUberWebhook,
      PollFleetStatus,
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
      QuoteDeliveries,
      ChargeDelivery,
      RecordFleetFee,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: SHIPPING_FACADE,
      inject: [
        DeliveryArea,
        PickupAvailability,
        BookCarrierDelivery,
        CarrierShipmentQuery,
        CancelCarrierDelivery,
        CarrierTrackingLinks,
        DeliveryAvailability,
        DeliveryChoice,
        PriceDelivery,
        QuoteDeliveries,
        ChargeDelivery,
        RecordFleetFee,
      ],
      useFactory: (
        area: DeliveryArea,
        pickup: PickupAvailability,
        book: BookCarrierDelivery,
        shipment: CarrierShipmentQuery,
        cancel: CancelCarrierDelivery,
        trackingLinks: CarrierTrackingLinks,
        availability: DeliveryAvailability,
        choice: DeliveryChoice,
        price: PriceDelivery,
        quote: QuoteDeliveries,
        charge: ChargeDelivery,
        fee: RecordFleetFee,
      ) =>
        new ShippingFacadeImplementation({
          area,
          pickup,
          book,
          shipment,
          cancel,
          trackingLinks,
          availability,
          choice,
          price,
          quote,
          charge,
          fee,
        }),
    },
  ],
  exports: [SHIPPING_FACADE],
})
export class ShippingModule {}
