import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CatalogModule } from '../catalog';
import { InventoryModule } from '../inventory';
import { PricingModule } from '../pricing';
import { SellersModule } from '../sellers';
import type { CartDependencies } from './application/cart-operations';
import { CART_POLICY } from './application/ports/cart-policy';
import { CART_REPOSITORY } from './application/ports/cart.repository';
import { GUEST_TOKENS } from './application/ports/guest-tokens';
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
import { cartProviders } from './infrastructure/cart-providers';
import { CartController } from './presentation/cart.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: CartDependencies) => U;

const PORTS: readonly [keyof CartDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['carts', CART_REPOSITORY],
  ['tokens', GUEST_TOKENS],
  ['policy', CART_POLICY],
  ['facts', LINE_FACTS_SOURCE],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
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
      AddGuestItem,
      SetGuestLineQuantity,
      RemoveGuestItem,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
  ],
})
export class CartModule {}
