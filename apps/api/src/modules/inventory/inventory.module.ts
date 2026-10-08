import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { IdentityModule } from '../identity';
import { INVENTORY_POLICY_PROVIDER } from './application/ports/inventory-policy-provider';
import { SELLER_INVENTORY_REPOSITORY } from './application/ports/seller-inventory.repository';
import { CreateSource } from './application/use-cases/create-source.use-case';
import { EditSource } from './application/use-cases/edit-source.use-case';
import { ListSources } from './application/use-cases/list-sources.use-case';
import { ReorderSources } from './application/use-cases/reorder-sources.use-case';
import { INVENTORY_PERMISSIONS } from './contracts/permissions';
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
  policies: INVENTORY_POLICY_PROVIDER,
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
 * `inventory.ensure-seller-inventory` on `identity.seller-registered.v1`, checks at start-up that
 * every hosted Market has its `inventory` configuration, and (part 2) the seller's use cases
 * that list, add, edit and reorder stock locations. Their route arrives with the panel slice. The module publishes no
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
