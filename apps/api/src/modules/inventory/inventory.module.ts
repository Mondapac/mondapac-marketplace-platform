import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CatalogModule } from '../catalog';
import { IdentityModule } from '../identity';
import { AVAILABILITY_SIGNAL_REPOSITORY } from './application/ports/availability-signal.repository';
import { OFFER_SELL_UNITS_SOURCE } from './application/ports/offer-sell-units';
import { AVAILABILITY_READER } from './application/ports/availability-reader';
import { OFFER_STOCK_READER } from './application/ports/offer-stock.reader';
import { STOCK_REPOSITORY } from './application/ports/stock.repository';
import { RESERVATION_REPOSITORY } from './application/ports/reservation.repository';
import { ExpireReservations } from './application/use-cases/expire-reservations.use-case';
import { ReleaseOwnReservation } from './application/use-cases/release-own-reservation.use-case';
import { ReleaseReservation } from './application/use-cases/release-reservation.use-case';
import { Reserve } from './application/use-cases/reserve.use-case';
import { INVENTORY_ORDERING_PORT } from './contracts/ordering-port';
import { InventoryOrderingPortImplementation } from './presentation/ordering-port';
import { expireReservationsJob } from './presentation/jobs/expire-reservations.job';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { AvailabilitySystemQuery } from './application/use-cases/availability-system.use-case';
import { AvailabilityQuery } from './application/use-cases/availability.use-case';
import { ViewOfferStock } from './application/use-cases/view-offer-stock.use-case';
import { SetStockLevel } from './application/use-cases/set-stock-level.use-case';
import { INVENTORY_EVENTS } from './domain/events';
import { INVENTORY_POLICY_PROVIDER } from './application/ports/inventory-policy-provider';
import { SELLER_INVENTORY_REPOSITORY } from './application/ports/seller-inventory.repository';
import { CreateSource } from './application/use-cases/create-source.use-case';
import { EditSource } from './application/use-cases/edit-source.use-case';
import { ListSources } from './application/use-cases/list-sources.use-case';
import { ReorderSources } from './application/use-cases/reorder-sources.use-case';
import { INVENTORY_PERMISSIONS } from './contracts/permissions';
import { INVENTORY_FACADE } from './contracts/inventory.facade';
import { InventoryFacadeImplementation } from './presentation/inventory.facade';
import { SellerInventoryController } from './presentation/seller-inventory.controller';
import { RekeyMovedOffer } from './application/use-cases/rekey-moved-offer.use-case';
import { RetireSellUnits } from './application/use-cases/retire-sell-units.use-case';
import { EnsureSellerInventory } from './application/use-cases/ensure-seller-inventory.use-case';
import { inventoryProviders } from './infrastructure/inventory-providers';
import { assertInventoryConfigured } from './infrastructure/market-config-boot-check';
import { catalogRetirementSubscriptions } from './presentation/subscribers/catalog-retirement.subscriptions';
import { catalogOfferMovedSubscriptions } from './presentation/subscribers/catalog-offer-moved.subscriptions';
import { sellerInventorySubscriptions } from './presentation/subscribers/seller-inventory.subscriptions';

/**
 * The Nest token of each dependency name the use cases of inventory share: a use case's
 * dependency object is built from these by {@link useCaseProvider}, so a name always means the
 * same port.
 */
const PORT = {
  unitOfWork: UNIT_OF_WORK,
  inventories: SELLER_INVENTORY_REPOSITORY,
  policies: INVENTORY_POLICY_PROVIDER,
  stock: STOCK_REPOSITORY,
  offerStock: OFFER_STOCK_READER,
  reservations: RESERVATION_REPOSITORY,
  items: AVAILABILITY_READER,
  signals: AVAILABILITY_SIGNAL_REPOSITORY,
  offers: OFFER_SELL_UNITS_SOURCE,
  outbox: OUTBOX_WRITER,
  ids: ID_GENERATOR,
  clock: CLOCK,
} as const satisfies Record<string, InjectionToken>;

type PortName = keyof typeof PORT;

/** What the release use cases and the expiry job share: the lock, the held sums and the signals. */
const RELEASE_PORTS = {
  unitOfWork: true,
  reservations: true,
  inventories: true,
  policies: true,
  signals: true,
  outbox: true,
  ids: true,
  clock: true,
} as const;

/**
 * The provider of one use case: the gate and the named ports, in a dependency object. `ports`
 * names every key of the use case's own dependency type, each a key of {@link PORT}, and no
 * other: the type checker refuses a missing, unknown or misnamed dependency.
 */
function useCaseProvider<D, U>(
  type: new (gate: UseCaseGate, deps: D) => U,
  ports: { readonly [K in keyof D]-?: K extends PortName ? true : never },
): FactoryProvider<U> {
  const names = Object.keys(ports) as PortName[];
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...names.map((name) => PORT[name])],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(gate, Object.fromEntries(names.map((name, index) => [name, values[index]])) as D),
  };
}

/**
 * The inventory bounded context (docs/design/domain/inventory.md; ADR-0013), filled slice by
 * slice. Slice 1 binds the seller inventory store and the handler
 * `inventory.ensure-seller-inventory` on `identity.seller-registered.v1`, checks at start-up that
 * every hosted Market has its `inventory` configuration, and (part 2) the seller's use cases
 * that list, add, edit and reorder stock locations. Their route arrives with the panel slice.
 * Slice 2 (part 3) adds the module's outbox, its two events and the seller's stock write
 * `inventory.set-stock-level`; until catalog slice 7, catalog's fail-closed `offerSellUnits` answers
 * every Offer as absent, so every stock write answers `inventory.not-found`.
 */
@Module({
  imports: [IdentityModule, CatalogModule],
  controllers: [SellerInventoryController],
  providers: [
    PersistenceModule.outboxWriterFor('inventory'),
    registerEvents('inventory', INVENTORY_EVENTS),
    ...inventoryProviders,
    {
      provide: 'INVENTORY_MARKET_CONFIG_CHECK',
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry) => {
        assertInventoryConfigured(markets);
        return true;
      },
    },
    // Pushes its catalogue into the permission registry (identity slice 8a-1, PF 6.1).
    registerPermissions('inventory', INVENTORY_PERMISSIONS),
    useCaseProvider(ListSources, { unitOfWork: true, inventories: true, policies: true }),
    useCaseProvider(CreateSource, {
      unitOfWork: true,
      inventories: true,
      policies: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(EditSource, { unitOfWork: true, inventories: true, policies: true }),
    useCaseProvider(ReorderSources, { unitOfWork: true, inventories: true, policies: true }),
    useCaseProvider(SetStockLevel, {
      unitOfWork: true,
      inventories: true,
      stock: true,
      signals: true,
      offers: true,
      policies: true,
      outbox: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(ViewOfferStock, {
      unitOfWork: true,
      inventories: true,
      offerStock: true,
      offers: true,
      clock: true,
    }),
    useCaseProvider(EnsureSellerInventory, {
      unitOfWork: true,
      inventories: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(RetireSellUnits, {
      unitOfWork: true,
      stock: true,
      signals: true,
      outbox: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(RekeyMovedOffer, {
      unitOfWork: true,
      inventories: true,
      stock: true,
      reservations: true,
      signals: true,
      offers: true,
      policies: true,
      outbox: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(AvailabilityQuery, {
      unitOfWork: true,
      items: true,
      signals: true,
      clock: true,
    }),
    useCaseProvider(AvailabilitySystemQuery, {
      unitOfWork: true,
      items: true,
      signals: true,
      clock: true,
    }),
    useCaseProvider(Reserve, {
      unitOfWork: true,
      reservations: true,
      inventories: true,
      policies: true,
      signals: true,
      outbox: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(ReleaseReservation, RELEASE_PORTS),
    useCaseProvider(ReleaseOwnReservation, RELEASE_PORTS),
    useCaseProvider(ExpireReservations, RELEASE_PORTS),
    {
      provide: INVENTORY_ORDERING_PORT,
      inject: [Reserve, ReleaseReservation, ReleaseOwnReservation],
      useFactory: (
        reserve: Reserve,
        releaseReservation: ReleaseReservation,
        releaseOwnReservation: ReleaseOwnReservation,
      ) =>
        new InventoryOrderingPortImplementation({
          reserve,
          releaseReservation,
          releaseOwnReservation,
        }),
    },
    registerJobsFrom('inventory', [ExpireReservations], (expire: ExpireReservations) => [
      expireReservationsJob(expire),
    ]),
    {
      provide: INVENTORY_FACADE,
      inject: [AvailabilityQuery, AvailabilitySystemQuery],
      useFactory: (availability: AvailabilityQuery, availabilitySystem: AvailabilitySystemQuery) =>
        new InventoryFacadeImplementation({ availability, availabilitySystem }),
    },
    registerSubscriptionsFrom(
      'inventory',
      [EnsureSellerInventory, RetireSellUnits, RekeyMovedOffer],
      (ensure: EnsureSellerInventory, retire: RetireSellUnits, rekey: RekeyMovedOffer) => [
        ...sellerInventorySubscriptions(ensure),
        ...catalogRetirementSubscriptions(retire),
        ...catalogOfferMovedSubscriptions(rekey),
      ],
    ),
  ],
  exports: [INVENTORY_FACADE, INVENTORY_ORDERING_PORT],
})
export class InventoryModule {}
