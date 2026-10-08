import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { IdentityModule } from '../identity';
import { SELLER_INVENTORY_REPOSITORY } from './application/ports/seller-inventory.repository';
import { EnsureSellerInventory } from './application/use-cases/ensure-seller-inventory.use-case';
import { inventoryProviders } from './infrastructure/inventory-providers';
import { assertInventoryConfigured } from './infrastructure/market-config-boot-check';
import { sellerInventorySubscriptions } from './presentation/subscribers/seller-inventory.subscriptions';

/**
 * The Nest token of each dependency name the use cases of inventory share: a use case's
 * dependency object is built from these by {@link useCaseProvider}, so a name always means the
 * same port.
 */
const PORT = {
  unitOfWork: UNIT_OF_WORK,
  inventories: SELLER_INVENTORY_REPOSITORY,
  ids: ID_GENERATOR,
  clock: CLOCK,
} as const satisfies Record<string, InjectionToken>;

type PortName = keyof typeof PORT;

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
 * `inventory.ensure-seller-inventory` on `identity.seller-registered.v1`, and checks at
 * start-up that every hosted Market has its `inventory` configuration. The module publishes no
 * event yet, so it has no outbox until slice 2.
 */
@Module({
  imports: [IdentityModule],
  providers: [
    ...inventoryProviders,
    {
      provide: 'INVENTORY_MARKET_CONFIG_CHECK',
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry) => {
        assertInventoryConfigured(markets);
        return true;
      },
    },
    useCaseProvider(EnsureSellerInventory, {
      unitOfWork: true,
      inventories: true,
      ids: true,
      clock: true,
    }),
    registerSubscriptionsFrom(
      'inventory',
      [EnsureSellerInventory],
      (ensure: EnsureSellerInventory) => sellerInventorySubscriptions(ensure),
    ),
  ],
})
export class InventoryModule {}
