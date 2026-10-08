import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
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
];
