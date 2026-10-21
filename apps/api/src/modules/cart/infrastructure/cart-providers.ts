import type { FactoryProvider } from '@nestjs/common';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { CATALOG_FACADE, type CatalogFacade } from '../../catalog';
import { INVENTORY_FACADE, type InventoryFacade } from '../../inventory';
import { PRICING_FACADE, type PricingFacade } from '../../pricing';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { SHIPPING_FACADE, type ShippingFacade } from '../../shipping';
import { CART_POLICY, type CartPolicy } from '../application/ports/cart-policy';
import { CART_REPOSITORY, type CartRepository } from '../application/ports/cart.repository';
import { GUEST_TOKENS, type GuestTokens } from '../application/ports/guest-tokens';
import { LINE_FACTS_SOURCE, type LineFactsSource } from '../application/ports/line-facts';
import { RATE_COUNTER_KEYS, type RateCounterKeys } from '../application/ports/rate-counter-keys';
import {
  SAVED_ITEM_REPOSITORY,
  type SavedItemRepository,
} from '../application/ports/saved-item.repository';
import {
  RATE_COUNTER_REPOSITORY,
  type RateCounterRepository,
} from '../application/ports/rate-counter.repository';
import { ConfigCartPolicy } from './config-cart-policy';
import { CryptoGuestTokens } from './crypto-guest-tokens';
import { FacadeLineFacts } from './facade-line-facts';
import { HmacRateCounterKeys, localCartSecret } from './hmac-rate-counter-keys';
import { PrismaCartRepository } from './prisma-cart.repository';
import { PrismaRateCounterRepository } from './prisma-rate-counter.repository';
import { PrismaSavedItemRepository } from './prisma-saved-item.repository';

const CART_SECRET = Symbol('CART_SECRET');

/** Binds the ports of the cart. Only this layer may reach `PrismaService` and the other modules' facades. */
export const cartProviders: readonly FactoryProvider[] = [
  {
    provide: CART_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CartRepository => new PrismaCartRepository(prisma),
  },
  {
    provide: SAVED_ITEM_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SavedItemRepository =>
      new PrismaSavedItemRepository(prisma),
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
    inject: [CATALOG_FACADE, SELLERS_FACADE, PRICING_FACADE, INVENTORY_FACADE, SHIPPING_FACADE],
    useFactory: (
      catalog: CatalogFacade,
      sellers: SellersFacade,
      pricing: PricingFacade,
      inventory: InventoryFacade,
      shipping: ShippingFacade,
    ): LineFactsSource => new FacadeLineFacts(catalog, sellers, pricing, inventory, shipping),
  },
  {
    provide: RATE_COUNTER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RateCounterRepository =>
      new PrismaRateCounterRepository(prisma),
  },
  {
    // The local stand-in of the cart stack secret refuses production (K1).
    provide: CART_SECRET,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): Uint8Array => localCartSecret(config),
  },
  {
    provide: RATE_COUNTER_KEYS,
    inject: [CART_SECRET],
    useFactory: (secret: Uint8Array): RateCounterKeys => new HmacRateCounterKeys(secret),
  },
];
