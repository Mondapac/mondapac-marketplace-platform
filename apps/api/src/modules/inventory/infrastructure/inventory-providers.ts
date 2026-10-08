import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  INVENTORY_POLICY_PROVIDER,
  type InventoryPolicyProvider,
} from '../application/ports/inventory-policy-provider';
import { ConfigInventoryPolicyProvider } from './config-inventory-policy-provider';
import {
  SELLER_INVENTORY_REPOSITORY,
  type SellerInventoryRepository,
} from '../application/ports/seller-inventory.repository';
import { PrismaSellerInventoryRepository } from './prisma-seller-inventory.repository';

/**
 * Binds the ports of slice 1. They live in `infrastructure/` because only this layer may reach
 * `PrismaService` (dependency-cruiser `persistence-internals-are-private`).
 */
export const inventoryProviders: readonly FactoryProvider[] = [
  {
    provide: SELLER_INVENTORY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerInventoryRepository =>
      new PrismaSellerInventoryRepository(prisma),
  },
  {
    provide: INVENTORY_POLICY_PROVIDER,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): InventoryPolicyProvider =>
      new ConfigInventoryPolicyProvider(markets),
  },
];
