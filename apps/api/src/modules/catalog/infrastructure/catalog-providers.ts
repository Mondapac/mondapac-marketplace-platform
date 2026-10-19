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
import { OWN_OFFER_FINDER } from '../application/ports/own-offer-finder';
import { CLAIM_EVALUATOR, type ClaimEvaluator } from '../application/ports/claim-evaluator';
import {
  CATEGORY_PATHS_READER,
  type CategoryPathsReader,
} from '../application/ports/category-paths.reader';
import { CertificationClaimEvaluator } from './certification-claim-evaluator';
import { PrismaCategoryPathsReader } from './prisma-category-paths.reader';
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
import {
  SELLER_NAMES_READER,
  type SellerNamesReader,
} from '../application/ports/seller-names.reader';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { SellersSellerNamesReader } from './sellers-seller-names.reader';
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
import {
  SELL_UNIT_LABELS_READER,
  type SellUnitLabelsReader,
} from '../application/ports/sell-unit-labels.reader';
import {
  OFFER_TAX_CATEGORIES_READER,
  type OfferTaxCategoriesReader,
} from '../application/ports/offer-tax-categories.reader';
import { PrismaOfferTaxCategoriesReader } from './prisma-offer-tax-categories.reader';
import {
  PENDING_PRODUCT_REVISIONS_READER,
  type PendingProductRevisionsReader,
} from '../application/ports/pending-product-revisions.reader';
import { PrismaPendingProductRevisionsReader } from './prisma-pending-product-revisions.reader';
import {
  CATEGORY_TREE_READER,
  type CategoryTreeReader,
} from '../application/ports/category-tree.reader';
import { PrismaCategoryTreeReader } from './prisma-category-tree.reader';
import { PrismaSellUnitLabelsReader } from './prisma-sell-unit-labels.reader';
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
import {
  TAG_REEVALUATION_REQUESTS,
  type TagReevaluationRequestRepository,
} from '../application/ports/tag-reevaluation-requests';
import { PrismaTagReevaluationRequests } from './prisma-tag-reevaluation-requests';
import {
  OFFER_OWNER_NOTICES,
  type OfferOwnerNoticeRepository,
} from '../application/ports/offer-owner-notice.repository';
import { PrismaOfferOwnerNotices } from './prisma-offer-owner-notices';
import {
  TAG_SELECTION_READER,
  type TagSelectionReader,
} from '../application/ports/tag-selection.reader';
import { PrismaTagSelectionReader } from './prisma-tag-selection.reader';
import {
  OFFER_LISTINGS_READER,
  type OfferListingsReader,
} from '../application/ports/offer-listings.reader';
import { PrismaOfferListingsReader } from './prisma-offer-listings.reader';

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
    provide: OFFER_LISTINGS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferListingsReader =>
      new PrismaOfferListingsReader(prisma),
  },
  // The fan-out work queue (design 5.4; data design 3.18).
  {
    provide: TAG_REEVALUATION_REQUESTS,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): TagReevaluationRequestRepository =>
      new PrismaTagReevaluationRequests(prisma),
  },
  // The pending warnings to Offer owners (certification request C-6; data design 3.27).
  {
    provide: OFFER_OWNER_NOTICES,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferOwnerNoticeRepository =>
      new PrismaOfferOwnerNotices(prisma),
  },
  // The tag selections of the certification-event re-ask and the reconciliation (design 5.5, 5.6).
  {
    provide: TAG_SELECTION_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): TagSelectionReader => new PrismaTagSelectionReader(prisma),
  },
  // The same store answers the seller's Offer on a product (design 5.1a).
  { provide: OWN_OFFER_FINDER, useExisting: OFFER_REPOSITORY },
  // catalog design 5; ADR-0028: `certification.evaluateClaims` and the active type codes.
  {
    provide: CLAIM_EVALUATOR,
    inject: [CERTIFICATION_FACADE],
    useFactory: (certification: CertificationFacade): ClaimEvaluator =>
      new CertificationClaimEvaluator(certification),
  },
  {
    provide: CATEGORY_PATHS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CategoryPathsReader =>
      new PrismaCategoryPathsReader(prisma),
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
    provide: SELLER_NAMES_READER,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerNamesReader =>
      new SellersSellerNamesReader(sellers),
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
    provide: OFFER_TAX_CATEGORIES_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferTaxCategoriesReader =>
      new PrismaOfferTaxCategoriesReader(prisma),
  },
  {
    provide: PENDING_PRODUCT_REVISIONS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PendingProductRevisionsReader =>
      new PrismaPendingProductRevisionsReader(prisma),
  },
  {
    provide: CATEGORY_TREE_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CategoryTreeReader => new PrismaCategoryTreeReader(prisma),
  },
  {
    provide: SELL_UNIT_LABELS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellUnitLabelsReader =>
      new PrismaSellUnitLabelsReader(prisma),
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
