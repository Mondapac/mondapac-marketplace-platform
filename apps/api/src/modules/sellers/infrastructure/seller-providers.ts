import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  SELLER_ACCESS_CONTRACT,
  type SellerAccessContract,
} from '../../identity/contracts/seller-access.contract';
import {
  REGISTERED_SELLER_SOURCE,
  type RegisteredSellerSource,
} from '../application/ports/registered-seller-source';
import {
  SELLER_FILE_REPOSITORY,
  type SellerFileRepository,
} from '../application/ports/seller-file.repository';
import {
  SELLER_MARKET_POLICY,
  type SellerMarketPolicy,
} from '../application/ports/seller-market-policy';
import { IdentityRegisteredSellers } from './identity-registered-sellers';
import { MarketConfigSellerPolicy } from './market-config-seller-policy';
import { PrismaSellerFileRepository } from './prisma-seller-file.repository';

/**
 * Binds the ports of slice 1. They live in `infrastructure/` because only this layer may reach
 * `PrismaService` and identity's seller-access contract (dependency-cruiser
 * `persistence-internals-are-private`, `seller-access-contract-is-for-sellers`).
 */
export const sellerProviders: readonly FactoryProvider[] = [
  {
    provide: SELLER_FILE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerFileRepository =>
      new PrismaSellerFileRepository(prisma),
  },
  {
    provide: SELLER_MARKET_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): SellerMarketPolicy =>
      new MarketConfigSellerPolicy(markets),
  },
  {
    provide: REGISTERED_SELLER_SOURCE,
    inject: [SELLER_ACCESS_CONTRACT],
    useFactory: (identity: SellerAccessContract): RegisteredSellerSource =>
      new IdentityRegisteredSellers(identity),
  },
];
