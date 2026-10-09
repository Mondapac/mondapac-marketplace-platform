import type { Provider } from '@nestjs/common';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
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
import { RATE_COUNTER_KEYS, type RateCounterKeys } from '../application/ports/rate-counter-keys';
import {
  PRODUCT_REVISION_REPOSITORY,
  type ProductRevisionRepository,
} from '../application/ports/product-revision.repository';
import {
  RATE_COUNTER_REPOSITORY,
  type RateCounterRepository,
} from '../application/ports/rate-counter.repository';
import {
  WORKING_COPY_REPOSITORY,
  type WorkingCopyRepository,
} from '../application/ports/working-copy.repository';
import { CLAIM_TEXT_MATCHER, type ClaimTextMatcher } from '../application/ports/claim-text-matcher';
import { CertificationClaimTextMatcher } from './certification-claim-text-matcher';
import { CERTIFICATION_FACADE, type CertificationFacade } from '../../certification';
import { ConfigCatalogMarketPolicy } from './config-catalog-market-policy';
import { HmacRateCounterKeys, localCatalogSecret } from './hmac-rate-counter-keys';
import { PrismaRateCounterRepository } from './prisma-rate-counter.repository';
import { PrismaProductRevisionRepository } from './prisma-product-revision.repository';
import { PrismaWorkingCopyRepository } from './prisma-working-copy.repository';
import { CheckedInAttributeSeed } from './seed/checked-in-attribute-seed';
import { PrismaAttributeRepository } from './prisma-attribute.repository';
import { CheckedInCategorySeed } from './seed/checked-in-category-seed';
import { PrismaPlatformCategoryRepository } from './prisma-platform-category.repository';
import { PrismaProductRepository } from './prisma-product.repository';

const CATALOG_SECRET = Symbol('CATALOG_SECRET');

/**
 * Binds the ports of slices 1 to 3. They live in `infrastructure/` because only this layer may reach
 * `PrismaService` (dependency-cruiser `persistence-internals-are-private`).
 */
export const catalogProviders: readonly Provider[] = [
  // ADR-0031 decision 3: the binding of `certification.matchClaimTerms` (the placeholder is gone).
  {
    provide: CLAIM_TEXT_MATCHER,
    inject: [CERTIFICATION_FACADE],
    useFactory: (certification: CertificationFacade): ClaimTextMatcher =>
      new CertificationClaimTextMatcher(certification),
  },
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
  {
    provide: WORKING_COPY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): WorkingCopyRepository =>
      new PrismaWorkingCopyRepository(prisma),
  },
  {
    provide: PRODUCT_REVISION_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ProductRevisionRepository =>
      new PrismaProductRevisionRepository(prisma),
  },
  {
    provide: RATE_COUNTER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RateCounterRepository =>
      new PrismaRateCounterRepository(prisma),
  },
  {
    // The local stand-in of the catalog stack secret refuses production (K1).
    provide: CATALOG_SECRET,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): Uint8Array => localCatalogSecret(config),
  },
  {
    provide: RATE_COUNTER_KEYS,
    inject: [CATALOG_SECRET],
    useFactory: (secret: Uint8Array): RateCounterKeys => new HmacRateCounterKeys(secret),
  },
];
