import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import {
  FLAT_FEE_REPOSITORY,
  type FlatFeeRepository,
} from '../application/ports/flat-fee.repository';
import { SELLER_DIRECTORY, type SellerDirectory } from '../application/ports/seller-directory';
import { SHIPPING_POLICY, type ShippingPolicy } from '../application/ports/shipping-policy';
import { ConfigShippingPolicy } from './config-shipping-policy';
import { PrismaFlatFeeRepository } from './prisma-flat-fee.repository';
import { SellersSellerDirectory } from './sellers-seller-directory';

/** Binds the ports of shipping. Only this layer may reach `PrismaService`. */
export const shippingProviders: readonly FactoryProvider[] = [
  {
    provide: FLAT_FEE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): FlatFeeRepository => new PrismaFlatFeeRepository(prisma),
  },
  {
    provide: SHIPPING_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): ShippingPolicy => new ConfigShippingPolicy(markets),
  },
  {
    provide: SELLER_DIRECTORY,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerDirectory => new SellersSellerDirectory(sellers),
  },
];
