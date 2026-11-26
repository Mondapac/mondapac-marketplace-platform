import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { CHANGE_TRAIL } from '../../platform/audit/change-trail';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import {
  AUTHORISATION_CHECK,
  registerPermissions,
  USE_CASE_GATE,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { SECURITY_EVENTS } from '../../platform/security-events/security-events';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { SellersModule } from '../sellers';
import {
  createSystemChangeRegistrar,
  SYSTEM_ACTION_PROPOSER,
  SYSTEM_REQUEST_RECORDER,
} from '../system-requests';
import { FleetModelCreateApplier } from './application/shipping-appliers';
import {
  DELIVERY_REVIEW_AREA,
  DELIVERY_SETTINGS_SUBJECT_KIND,
  FLEET_MODEL_CREATE_SUBJECT_KIND,
  FLEET_MODEL_SUBJECT_KIND,
  FLEET_SELECTION_SUBJECT_KIND,
  SELLER_METHODS_SUBJECT_KIND,
} from './application/shipping-review';
import {
  DeliverySettingsReverter,
  FleetSelectionModelReverter,
  FleetSelectionReverter,
  SellerDeliveryMethodsReverter,
} from './application/shipping-reverters';
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
import type {
  FleetModelCreateDependencies,
  ShippingApplierDependencies,
  ShippingDependencies,
} from './application/shipping-dependencies';
import { DeliveryAvailability } from './application/use-cases/delivery-availability.use-case';
import { DeliveryChoice } from './application/use-cases/delivery-choice.use-case';
import { ChargeDelivery } from './application/use-cases/charge-delivery.use-case';
import { PriceDelivery } from './application/use-cases/price-delivery.use-case';
import { QuoteDeliveries } from './application/use-cases/quote-deliveries.use-case';
import { RecordFleetFee } from './application/use-cases/record-fleet-fee.use-case';
import { SetDeliverySettings } from './application/use-cases/set-delivery-settings.use-case';
import { SetSellerDeliveryMethods } from './application/use-cases/set-seller-delivery-methods.use-case';
import { changeTrailProvider, IdentityModule } from '../identity';
import { ViewDeliverySettingsHistory } from './application/use-cases/view-delivery-settings-history.use-case';
import { ViewFleetSelectionHistory } from './application/use-cases/view-fleet-selection-history.use-case';
import { ViewDeliverySettings } from './application/use-cases/view-delivery-settings.use-case';
import { ViewSellerDeliveryMethods } from './application/use-cases/view-seller-delivery-methods.use-case';
import { CreateFleetSelectionModel } from './application/use-cases/create-fleet-selection-model.use-case';
import { SetFleetSelection } from './application/use-cases/set-fleet-selection.use-case';
import { UpdateFleetSelectionModel } from './application/use-cases/update-fleet-selection-model.use-case';
import { ViewFleetSelection } from './application/use-cases/view-fleet-selection.use-case';
import { BookCarrierDelivery } from './application/use-cases/book-carrier-delivery.use-case';
import { CancelCarrierDelivery } from './application/use-cases/cancel-carrier-delivery.use-case';
import { CarrierTrackingLinks } from './application/use-cases/carrier-tracking-links.use-case';
import { CarrierProgressOf } from './application/use-cases/carrier-progress-of.use-case';
import { DeliveryRegionsQuery } from './application/use-cases/delivery-regions.use-case';
import { CarrierShipmentQuery } from './application/use-cases/carrier-shipment.use-case';
import { DeliveryArea } from './application/use-cases/delivery-area.use-case';
import { DeliveryAreaMap } from './application/use-cases/delivery-area-map.use-case';
import { PickupAvailability } from './application/use-cases/pickup-availability.use-case';
import { PollFleetStatus } from './application/use-cases/poll-fleet-status.use-case';
import { ReceiveUberWebhook } from './application/use-cases/receive-uber-webhook.use-case';
import { ReceiveCarrierWebhook } from './application/use-cases/receive-carrier-webhook.use-case';
import { SHIPPING_FACADE, SHIPPING_PERMISSIONS, SHIPPING_REPORTING_FACADE } from './contracts';
import { ShippingReportingFacadeImplementation } from './presentation/shipping-reporting.facade';
import { SHIPPING_AUDIT_ACTIONS } from './domain/audit';
import { SHIPPING_EVENTS } from './domain/events';
import { shippingProviders } from './infrastructure/shipping-providers';
import { pollFleetStatusJob } from './presentation/jobs/poll-fleet-status.job';
import { UberWebhookController } from './presentation/uber-webhook.controller';
import { CarrierWebhookController } from './presentation/carrier-webhook.controller';
import { DeliverySettingsController } from './presentation/delivery-settings.controller';
import { FleetSelectionController } from './presentation/fleet-selection.controller';
import { DeliveryAreaController } from './presentation/delivery-area.controller';
import { DeliveryAreaMapController } from './presentation/delivery-area-map.controller';
import { ShippingFacadeImplementation } from './presentation/shipping.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: ShippingDependencies) => U;

/** This module's own registrar for System requests (never exported from the barrel). */
const SHIPPING_SYSTEM_CHANGES = createSystemChangeRegistrar('shipping');

const PORTS: readonly [keyof ShippingDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['policy', SHIPPING_POLICY],
  ['sellers', SELLER_DIRECTORY],
  ['audit', AUDIT_WRITER],
  ['review', SYSTEM_REQUEST_RECORDER],
  ['trail', CHANGE_TRAIL],
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

const dependenciesOf = (values: readonly unknown[]): ShippingDependencies =>
  Object.fromEntries(
    PORTS.map(([name], index) => [name, values[index]]),
  ) as unknown as ShippingDependencies;

/** The reverters of area delivery (Admin Inbox › System requests), registered below. */
const REVERTERS = [
  [DELIVERY_SETTINGS_SUBJECT_KIND, DeliverySettingsReverter],
  [SELLER_METHODS_SUBJECT_KIND, SellerDeliveryMethodsReverter],
  [FLEET_SELECTION_SUBJECT_KIND, FleetSelectionReverter],
  [FLEET_MODEL_SUBJECT_KIND, FleetSelectionModelReverter],
] as const;

/**
 * Every key the action's own route declares (its use case's `allOf`), so the approver needs what
 * the author needed: derived from the declaration, it cannot drift from it.
 */
function routeKeys(access: AccessDeclaration): readonly string[] {
  if (access.rule.kind !== 'permissions' || access.rule.allOf.length === 0) {
    throw new Error(`shipping: ${access.name} declares no permission keys`);
  }
  return access.rule.allOf;
}

/** The token of the applier of a new fleet-selection model (approval mode). */
const FLEET_MODEL_CREATE_APPLIER = Symbol(`SHIPPING_APPLIER:${FLEET_MODEL_CREATE_SUBJECT_KIND}`);

/** The keys each approval kind of area delivery is registered with (read by the wiring spec). */
export const SHIPPING_APPLIER_PERMISSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  [FLEET_MODEL_CREATE_SUBJECT_KIND, routeKeys(CreateFleetSelectionModel.access)],
]);

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
  imports: [SellersModule, IdentityModule],
  controllers: [
    DeliveryAreaController,
    DeliveryAreaMapController,
    CarrierWebhookController,
    UberWebhookController,
    FleetSelectionController,
    DeliverySettingsController,
  ],
  providers: [
    PersistenceModule.auditWriterFor('shipping'),
    PersistenceModule.auditTrailReaderFor('shipping'),
    changeTrailProvider(),
    PersistenceModule.securityEventsFor('shipping'),
    registerAuditActions('shipping', SHIPPING_AUDIT_ACTIONS),
    registerPermissions('shipping', SHIPPING_PERMISSIONS),
    registerEvents('shipping', SHIPPING_EVENTS),
    PersistenceModule.outboxWriterFor('shipping'),
    ...shippingProviders,
    ...REVERTERS.flatMap(([kind, Reverter]) => {
      const token = Symbol(`SHIPPING_REVERTER:${kind}`);
      return [
        {
          provide: token,
          inject: PORTS.map(([, port]) => port),
          useFactory: (...values: unknown[]) => new Reverter(dependenciesOf(values)),
        },
        SHIPPING_SYSTEM_CHANGES.reverter(kind, DELIVERY_REVIEW_AREA, token),
      ];
    }),
    // The create of a model waits for approval where the Market reviews area delivery.
    {
      provide: FLEET_MODEL_CREATE_APPLIER,
      inject: [...PORTS.map(([, port]) => port), AUTHORISATION_CHECK],
      useFactory: (...values: unknown[]) =>
        new FleetModelCreateApplier({
          ...dependenciesOf(values),
          authorisation: values[PORTS.length],
        } as ShippingApplierDependencies),
    },
    SHIPPING_SYSTEM_CHANGES.applier(
      FLEET_MODEL_CREATE_SUBJECT_KIND,
      DELIVERY_REVIEW_AREA,
      SHIPPING_APPLIER_PERMISSIONS.get(FLEET_MODEL_CREATE_SUBJECT_KIND) ?? [],
      FLEET_MODEL_CREATE_APPLIER,
    ),
    {
      provide: CreateFleetSelectionModel,
      inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token), SYSTEM_ACTION_PROPOSER],
      useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
        new CreateFleetSelectionModel(gate, {
          ...dependenciesOf(values),
          proposer: values[PORTS.length],
        } as FleetModelCreateDependencies),
    },
    registerJobsFrom('shipping', [PollFleetStatus], (poll: PollFleetStatus) => [
      pollFleetStatusJob(poll),
    ]),
    ...[
      DeliveryArea,
      DeliveryAreaMap,
      PickupAvailability,
      BookCarrierDelivery,
      CarrierShipmentQuery,
      CarrierTrackingLinks,
      CarrierProgressOf,
      CancelCarrierDelivery,
      ReceiveCarrierWebhook,
      ReceiveUberWebhook,
      PollFleetStatus,
      ViewFleetSelection,
      ViewFleetSelectionHistory,
      ViewDeliverySettingsHistory,
      UpdateFleetSelectionModel,
      SetFleetSelection,
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
      DeliveryRegionsQuery,
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
        CarrierProgressOf,
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
        progress: CarrierProgressOf,
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
          progress,
          availability,
          choice,
          price,
          quote,
          charge,
          fee,
        }),
    },
    // What reporting reads (dashboards v2): region codes only, never a postcode.
    {
      provide: SHIPPING_REPORTING_FACADE,
      inject: [DeliveryRegionsQuery],
      useFactory: (regions: DeliveryRegionsQuery) =>
        new ShippingReportingFacadeImplementation(regions),
    },
  ],
  exports: [SHIPPING_FACADE, SHIPPING_REPORTING_FACADE],
})
export class ShippingModule {}
