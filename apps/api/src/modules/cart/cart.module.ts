import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CatalogModule } from '../catalog';
import { InventoryModule } from '../inventory';
import { PricingModule } from '../pricing';
import { SellersModule } from '../sellers';
import type { CartDependencies } from './application/cart-operations';
import { CART_POLICY } from './application/ports/cart-policy';
import { CART_REPOSITORY } from './application/ports/cart.repository';
import { GUEST_TOKENS } from './application/ports/guest-tokens';
import { RATE_COUNTER_KEYS } from './application/ports/rate-counter-keys';
import { RATE_COUNTER_REPOSITORY } from './application/ports/rate-counter.repository';
import { LINE_FACTS_SOURCE } from './application/ports/line-facts';
import { AddGuestItem } from './application/use-cases/add-guest-item.use-case';
import { AddItem } from './application/use-cases/add-item.use-case';
import { MergeGuestCart } from './application/use-cases/merge-guest-cart.use-case';
import { RemoveGuestItem } from './application/use-cases/remove-guest-item.use-case';
import { RemoveItem } from './application/use-cases/remove-item.use-case';
import { SetGuestLineQuantity } from './application/use-cases/set-guest-line-quantity.use-case';
import { SetLineQuantity } from './application/use-cases/set-line-quantity.use-case';
import { ViewCart } from './application/use-cases/view-cart.use-case';
import { ViewGuestCart } from './application/use-cases/view-guest-cart.use-case';
import { ClearOrderedLines } from './application/use-cases/clear-ordered-lines.use-case';
import { PurgeInactiveCarts } from './application/use-cases/purge-inactive-carts.use-case';
import { ReadCheckoutLines } from './application/use-cases/read-checkout-lines.use-case';
import { CART_CHECKOUT_FACADE } from './contracts';
import { cartProviders } from './infrastructure/cart-providers';
import { CartCheckoutFacadeImplementation } from './presentation/cart-checkout.facade';
import { CartController } from './presentation/cart.controller';
import { purgeInactiveCartsJob } from './presentation/jobs/purge-inactive-carts.job';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: CartDependencies) => U;

const PORTS: readonly [keyof CartDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['carts', CART_REPOSITORY],
  ['tokens', GUEST_TOKENS],
  ['policy', CART_POLICY],
  ['facts', LINE_FACTS_SOURCE],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['counters', RATE_COUNTER_REPOSITORY],
  ['counterKeys', RATE_COUNTER_KEYS],
];

/** Every cart use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as CartDependencies,
      ),
  };
}

/**
 * The cart (docs/design/domain/cart.md, simplified for speed mode): a customer's or a guest's
 * lines of sell units, checked against catalog, sellers, pricing and inventory on every read and
 * every add. The cart reserves no stock and fixes no price; the hold and the price lock arrive
 * with checkout.
 */
@Module({
  imports: [CatalogModule, SellersModule, PricingModule, InventoryModule],
  controllers: [CartController],
  providers: [
    ...cartProviders,
    ...[
      ViewCart,
      AddItem,
      SetLineQuantity,
      RemoveItem,
      MergeGuestCart,
      ViewGuestCart,
      ReadCheckoutLines,
      ClearOrderedLines,
      AddGuestItem,
      SetGuestLineQuantity,
      RemoveGuestItem,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: PurgeInactiveCarts,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        CART_REPOSITORY,
        RATE_COUNTER_REPOSITORY,
        CART_POLICY,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: CartDependencies['unitOfWork'],
        carts: CartDependencies['carts'],
        counters: CartDependencies['counters'],
        policy: CartDependencies['policy'],
        clock: CartDependencies['clock'],
      ) => new PurgeInactiveCarts(gate, { unitOfWork, carts, counters, policy, clock }),
    },
    registerJobsFrom('cart', [PurgeInactiveCarts], (purge: PurgeInactiveCarts) => [
      purgeInactiveCartsJob(purge),
    ]),
    {
      provide: CART_CHECKOUT_FACADE,
      inject: [ReadCheckoutLines, ClearOrderedLines],
      useFactory: (read: ReadCheckoutLines, clear: ClearOrderedLines) =>
        new CartCheckoutFacadeImplementation(read, clear),
    },
  ],
  exports: [CART_CHECKOUT_FACADE],
})
export class CartModule {}
