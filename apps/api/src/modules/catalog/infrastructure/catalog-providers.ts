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
import { OFFER_REPOSITORY, type OfferRepository } from '../application/ports/offer.repository';
import { OFFER_NAMES_READER, type OfferNamesReader } from '../application/ports/offer-names.reader';
import {
  OFFER_SEARCH_FACTS_READER,
  type OfferSearchFactsReader,
} from '../application/ports/offer-search-facts.reader';
import {
  OFFER_SELL_UNITS_READER,
  type OfferSellUnitsReader,
} from '../application/ports/offer-sell-units.reader';
import {
  ALLOWED_PRODUCT_TYPES_READER,
  type AllowedProductTypesReader,
} from '../application/ports/allowed-product-types.reader';
import {
  SELLER_ELIGIBILITY_READER,
  type SellerEligibilityReader,
} from '../application/ports/seller-eligibility.reader';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { SellersAllowedProductTypesReader } from './sellers-allowed-product-types.reader';
import { SellersSellerEligibilityReader } from './sellers-seller-eligibility.reader';
import { PrismaOfferRepository } from './prisma-offer.repository';
import { PrismaOwnCatalogReader } from './prisma-own-catalog.reader';
import {
  PRODUCT_IMAGE_REPOSITORY,
  type ProductImageRepository,
} from '../application/ports/product-image.repository';
import { IMAGE_PROCESSOR, type ImageProcessor } from '../application/ports/image-processor';
import { PrismaProductImageRepository } from './prisma-product-image.repository';
import { SharpImageProcessor } from './sharp-image-processor';
import { OWN_CATALOG_READER, type OwnCatalogReader } from '../application/ports/own-catalog.reader';
import { PrismaOfferSearchFactsReader } from './prisma-offer-search-facts.reader';
import { PrismaOfferNamesReader } from './prisma-offer-names.reader';
import { PrismaOfferSellUnitsReader } from './prisma-offer-sell-units.reader';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import type { IdGenerator } from '@mondapac/shared-kernel';
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
    provide: OFFER_REPOSITORY,
    inject: [PrismaService, ID_GENERATOR],
    useFactory: (prisma: PrismaService, ids: IdGenerator): OfferRepository =>
      new PrismaOfferRepository(prisma, ids),
  },
  {
    provide: OWN_CATALOG_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OwnCatalogReader => new PrismaOwnCatalogReader(prisma),
  },
  {
    provide: SELLER_ELIGIBILITY_READER,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerEligibilityReader =>
      new SellersSellerEligibilityReader(sellers),
  },
  {
    provide: ALLOWED_PRODUCT_TYPES_READER,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): AllowedProductTypesReader =>
      new SellersAllowedProductTypesReader(sellers),
  },
  {
    provide: OFFER_NAMES_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferNamesReader => new PrismaOfferNamesReader(prisma),
  },
  {
    provide: OFFER_SELL_UNITS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferSellUnitsReader =>
      new PrismaOfferSellUnitsReader(prisma),
  },
  {
    provide: OFFER_SEARCH_FACTS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferSearchFactsReader =>
      new PrismaOfferSearchFactsReader(prisma),
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
    provide: PRODUCT_IMAGE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ProductImageRepository =>
      new PrismaProductImageRepository(prisma),
  },
  {
    provide: IMAGE_PROCESSOR,
    useFactory: (): ImageProcessor => new SharpImageProcessor(),
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
