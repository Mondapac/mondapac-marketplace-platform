import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  PRODUCT_REPOSITORY,
  type ProductRepository,
} from '../application/ports/product.repository';
import { CATEGORY_SEED, type CategorySeed } from '../application/ports/category-seed';
import {
  PLATFORM_CATEGORY_REPOSITORY,
  type PlatformCategoryRepository,
} from '../application/ports/platform-category.repository';
import {
  ATTRIBUTE_REPOSITORY,
  type AttributeRepository,
} from '../application/ports/attribute.repository';
import { ATTRIBUTE_SEED, type AttributeSeed } from '../application/ports/attribute-seed';
import {
  CATALOG_MARKET_POLICY,
  type CatalogMarketPolicy,
} from '../application/ports/catalog-market-policy';
import { ConfigCatalogMarketPolicy } from './config-catalog-market-policy';
import { CheckedInAttributeSeed } from './seed/checked-in-attribute-seed';
import { PrismaAttributeRepository } from './prisma-attribute.repository';
import { CheckedInCategorySeed } from './seed/checked-in-category-seed';
import { PrismaPlatformCategoryRepository } from './prisma-platform-category.repository';
import { PrismaProductRepository } from './prisma-product.repository';

/**
 * Binds the ports of slices 1 to 3. They live in `infrastructure/` because only this layer may reach
 * `PrismaService` (dependency-cruiser `persistence-internals-are-private`).
 */
export const catalogProviders: readonly FactoryProvider[] = [
  {
    provide: CATALOG_MARKET_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): CatalogMarketPolicy =>
      new ConfigCatalogMarketPolicy(markets),
  },
  {
    provide: PRODUCT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ProductRepository => new PrismaProductRepository(prisma),
  },
  {
    provide: PLATFORM_CATEGORY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PlatformCategoryRepository =>
      new PrismaPlatformCategoryRepository(prisma),
  },
  {
    provide: CATEGORY_SEED,
    useFactory: (): CategorySeed => new CheckedInCategorySeed(),
  },
  {
    provide: ATTRIBUTE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AttributeRepository =>
      new PrismaAttributeRepository(prisma),
  },
  {
    provide: ATTRIBUTE_SEED,
    useFactory: (): AttributeSeed => new CheckedInAttributeSeed(),
  },
];
