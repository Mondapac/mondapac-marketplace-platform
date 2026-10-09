import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { CATALOG_FACADE, type CatalogFacade } from '../../catalog';
import { INVENTORY_FACADE, type InventoryFacade } from '../../inventory';
import { PRICING_FACADE, type PricingFacade } from '../../pricing';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { CART_POLICY, type CartPolicy } from '../application/ports/cart-policy';
import { CART_REPOSITORY, type CartRepository } from '../application/ports/cart.repository';
import { GUEST_TOKENS, type GuestTokens } from '../application/ports/guest-tokens';
import { LINE_FACTS_SOURCE, type LineFactsSource } from '../application/ports/line-facts';
import { ConfigCartPolicy } from './config-cart-policy';
import { CryptoGuestTokens } from './crypto-guest-tokens';
import { FacadeLineFacts } from './facade-line-facts';
import { PrismaCartRepository } from './prisma-cart.repository';

/** Binds the ports of the cart. Only this layer may reach `PrismaService` and the other modules' facades. */
export const cartProviders: readonly FactoryProvider[] = [
  {
    provide: CART_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CartRepository => new PrismaCartRepository(prisma),
  },
  {
    provide: GUEST_TOKENS,
    useFactory: (): GuestTokens => new CryptoGuestTokens(),
  },
  {
    provide: CART_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): CartPolicy => new ConfigCartPolicy(markets),
  },
  {
    provide: LINE_FACTS_SOURCE,
    inject: [CATALOG_FACADE, SELLERS_FACADE, PRICING_FACADE, INVENTORY_FACADE],
    useFactory: (
      catalog: CatalogFacade,
      sellers: SellersFacade,
      pricing: PricingFacade,
      inventory: InventoryFacade,
    ): LineFactsSource => new FacadeLineFacts(catalog, sellers, pricing, inventory),
  },
];
