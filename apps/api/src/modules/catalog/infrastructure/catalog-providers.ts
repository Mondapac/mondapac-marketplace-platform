import type { Provider } from '@nestjs/common';
import {
  CATEGORY_PROPOSAL_CAPABILITY,
  CATEGORY_PROPOSAL_POLICY,
  type CategoryProposalCapability,
  type CategoryProposalPolicy,
} from '../application/ports/category-proposal-capability';
import {
  SELLER_CATEGORY_STORE,
  type SellerCategoryStore,
} from '../application/ports/seller-category.store';
import { PrismaSellerCategoryStore } from './prisma-seller-category.store';
import { SellersCategoryProposalCapability } from './sellers-category-proposal-capability';
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
import { cultureMembersProvider } from './sellers-culture-members';
import {
  SELLER_CERTIFICATE_TYPES,
  SELLER_MEMBER_CULTURES,
  type SellerCertificateTypes,
  type SellerMemberCultures,
} from '../application/ports/culture-visibility-sources';
import {
  CertificationSellerCertificateTypes,
  SellersMemberCultures,
} from './culture-visibility-sources';
import { CLAIM_TERM_LOCALES, type ClaimTermLocales } from '../application/ports/claim-term-locales';
import {
  ATTRIBUTE_DEFINITION_STORE,
  type AttributeDefinitionStore,
} from '../application/ports/attribute-definition.store';
import { FEATURE_SET_STORE, type FeatureSetStore } from '../application/ports/feature-set.store';
import { CertificationClaimTermLocales } from './certification-claim-term-locales';
import { CertificationCategoryRetirement } from './certification-category-retirement';
import {
  CATEGORY_RETIREMENT_CHECK,
  type CategoryRetirementCheck,
} from '../application/ports/category-retirement-check';
import { PrismaAttributeDefinitionStore } from './prisma-attribute-definition.store';
import { PrismaFeatureSetStore } from './prisma-feature-set.store';
import {
  CATEGORY_ATTRIBUTE_LINK_STORE,
  type CategoryAttributeLinkStore,
} from '../application/ports/category-attribute-link.store';
import { PrismaCategoryAttributeLinkStore } from './prisma-category-attribute-link.store';
import { PrismaAttributeRelaxationStore } from './prisma-attribute-relaxation.store';
import { PrismaAttributeValueSuggestionStore } from './prisma-attribute-value-suggestion.store';
import { PrismaTopicSuggestionStore } from './prisma-topic-suggestion.store';
import {
  TOPIC_SUGGESTION_STORE,
  type TopicSuggestionStore,
} from '../application/ports/topic-suggestion.store';
import {
  ATTRIBUTE_VALUE_SUGGESTION_STORE,
  type AttributeValueSuggestionStore,
} from '../application/ports/attribute-value-suggestion.store';
import {
  ATTRIBUTE_RELAXATION_STORE,
  type AttributeRelaxationStore,
} from '../application/ports/attribute-relaxation.store';
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
  SELLER_ELIGIBILITY_STATUS_READER,
  type SellerEligibilityReader,
  type SellerEligibilityStatusReader,
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
import { PrismaAdminProductsReader } from './prisma-admin-products.reader';
import { PrismaAdminVariantsReader } from './prisma-admin-variants.reader';
import { PrismaCustomVariantLabelsReader } from './prisma-custom-variant-labels.reader';
import {
  CUSTOM_VARIANT_LABELS_READER,
  type CustomVariantLabelsReader,
} from '../application/ports/custom-variant-labels.reader';
import { PrismaSavedFilterRepository } from './prisma-saved-filter.repository';
import { PrismaSellerSavedFilterRepository } from './prisma-seller-saved-filter.repository';
import {
  SELLER_SAVED_FILTER_REPOSITORY,
  type SellerSavedFilterRepository,
} from '../application/ports/seller-saved-filter.repository';
import {
  SAVED_FILTER_REPOSITORY,
  type SavedFilterRepository,
} from '../application/ports/saved-filter.repository';
import {
  ADMIN_PRODUCTS_READER,
  type AdminProductsReader,
} from '../application/ports/admin-products.reader';
import {
  ADMIN_VARIANTS_READER,
  type AdminVariantsReader,
} from '../application/ports/admin-variants.reader';
import {
  PRODUCT_IMAGE_REPOSITORY,
  type ProductImageRepository,
} from '../application/ports/product-image.repository';
import { IMAGE_PROCESSOR, type ImageProcessor } from '../application/ports/image-processor';
import { PrismaProductImageRepository } from './prisma-product-image.repository';
import { SharpImageProcessor } from './sharp-image-processor';
import { csvParser } from '../domain/platform-import/import-file';
import {
  IMPORT_FILE_PARSERS,
  type ImportFileParsers,
} from '../application/ports/import-file-parsers';
import { SHEET_WRITER, type SheetWriter } from '../application/ports/sheet-writer';
import { ExceljsSheetWriter } from './xlsx/exceljs-sheet-writer';
import { xlsxParser } from './xlsx/isolated-xlsx-parser';
import { OWN_CATALOG_READER, type OwnCatalogReader } from '../application/ports/own-catalog.reader';
import { PrismaOfferSearchFactsReader } from './prisma-offer-search-facts.reader';
import {
  SEARCH_FILTER_READER,
  type SearchFilterReader,
} from '../application/ports/search-filter.reader';
import { PrismaSearchFilterReader } from './prisma-search-filter.reader';
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
  SELLER_PRODUCT_OWNERS_READER,
  type SellerProductOwnersReader,
} from '../application/ports/seller-product-owners.reader';
import {
  PRODUCT_LINKING_READER,
  type ProductLinkingReader,
} from '../application/ports/product-linking.reader';
import { PrismaProductLinkingReader } from './prisma-product-linking.reader';
import { PrismaSellerProductOwnersReader } from './prisma-seller-product-owners.reader';
import {
  CATEGORY_TREE_READER,
  type CategoryTreeReader,
} from '../application/ports/category-tree.reader';
import { PrismaCategoryTreeReader } from './prisma-category-tree.reader';
import {
  PUBLIC_CATEGORY_READER,
  type PublicCategoryReader,
} from '../application/ports/public-category.reader';
import { PrismaPublicCategoryReader } from './prisma-public-category.reader';
import {
  PRODUCT_SELL_UNIT_FACTS_READER,
  type ProductSellUnitFactsReader,
} from '../application/ports/product-sell-unit-facts.reader';
import { PrismaProductSellUnitFactsReader } from './prisma-product-sell-unit-facts.reader';
import { PrismaSellUnitLabelsReader } from './prisma-sell-unit-labels.reader';
import { PrismaOfferNamesReader } from './prisma-offer-names.reader';
import { PrismaOfferSellUnitsReader } from './prisma-offer-sell-units.reader';
import { PrismaOfferSellUnitRepository } from './prisma-offer-sell-unit.repository';
import {
  OFFER_SELL_UNIT_REPOSITORY,
  type OfferSellUnitRepository,
} from '../application/ports/offer-sell-unit.repository';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import type { IdGenerator } from '@mondapac/shared-kernel';
import { CertificationClaimTextMatcher } from './certification-claim-text-matcher';
import { CERTIFICATION_FACADE, type CertificationFacade } from '../../certification';
import { ConfigCatalogMarketPolicy } from './config-catalog-market-policy';
import { HmacRateCounterKeys, localCatalogSecret } from './hmac-rate-counter-keys';
import { PrismaRateCounterRepository } from './prisma-rate-counter.repository';
import { PrismaProductRevisionRepository } from './prisma-product-revision.repository';
import { OBJECT_STORE, type ObjectStore } from '../../../platform/storage/object-store';
import { PrismaWorkingCopyRepository } from './prisma-working-copy.repository';
import { PrismaPlatformImportRepository } from './prisma-platform-import.repository';
import { PrismaSellerImportRepository } from './prisma-seller-import.repository';
import { PrismaSellerImportFactsReader } from './prisma-seller-import-facts.reader';
import {
  SELLER_IMPORT_REPOSITORY,
  type SellerImportRepository,
} from '../application/ports/seller-import.repository';
import {
  SELLER_IMPORT_FACTS_READER,
  type SellerImportFactsReader,
} from '../application/ports/seller-import-facts.reader';
import { ObjectImportFileStore } from './object-import-file-store';
import { IMPORT_FILE_STORE, type ImportFileStore } from '../application/ports/import-file-store';
import {
  PLATFORM_IMPORT_REPOSITORY,
  type PlatformImportRepository,
} from '../application/ports/platform-import.repository';
import { CheckedInAttributeSeed } from './seed/checked-in-attribute-seed';
import { PrismaAttributeRepository } from './prisma-attribute.repository';
import { CheckedInCategorySeed } from './seed/checked-in-category-seed';
import { CULTURE_SEED, type CultureSeed } from '../application/ports/culture-seed';
import { CheckedInCultureSeed } from './seed/checked-in-culture-seed';
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
  MISSING_DETAILS_EMAIL_STORE,
  type MissingDetailsEmailStore,
} from '../application/ports/missing-details-email.store';
import { PrismaMissingDetailsEmailStore } from './prisma-missing-details-email.store';
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
import {
  PUBLISHED_PRODUCT_READER,
  type PublishedProductReader,
} from '../application/ports/published-product.reader';
import { PrismaPublishedProductReader } from './prisma-published-product.reader';
import {
  VARIANT_GTIN_REGISTRY,
  type VariantGtinRegistry,
} from '../application/ports/variant-gtin.registry';
import { PrismaVariantGtinRegistry } from './prisma-variant-gtin.registry';
import {
  PUBLISHED_IMAGES_READER,
  type PublishedImagesReader,
} from '../application/ports/published-images.reader';
import { PrismaPublishedImagesReader } from './prisma-published-images.reader';
import { BRAND_REPOSITORY, type BrandRepository } from '../application/ports/brand.repository';
import { BRAND_READER, type BrandReader } from '../application/ports/brand.reader';
import {
  ATTRIBUTE_ADMIN_READER,
  type AttributeAdminReader,
} from '../application/ports/attribute-admin.reader';
import { PrismaAttributeAdminReader } from './prisma-attribute-admin.reader';
import {
  ATTRIBUTE_IMPACT_READER,
  type AttributeImpactReader,
} from '../application/ports/attribute-impact.reader';
import { PrismaAttributeImpactReader } from './prisma-attribute-impact.reader';
import {
  PRODUCT_DETAILS_GAP_READER,
  type ProductDetailsGapReader,
} from '../application/ports/product-details-gap.reader';
import { PrismaProductDetailsGapReader } from './prisma-product-details-gap.reader';
import { BRAND_ASSIGNER, type BrandAssigner } from '../application/ports/brand-assigner';
import {
  BUSINESS_ACTIVITY_REPOSITORY,
  type BusinessActivityRepository,
} from '../application/ports/business-activity.repository';
import {
  BUSINESS_ACTIVITY_READER,
  type BusinessActivityReader,
} from '../application/ports/business-activity.reader';
import {
  CULTURE_REPOSITORY,
  type CultureRepository,
} from '../application/ports/culture.repository';
import { CULTURE_READER, type CultureReader } from '../application/ports/culture.reader';
import { PrismaCultureRepository } from './prisma-culture.repository';
import { PrismaCultureReader } from './prisma-culture.reader';
import { PrismaBusinessActivityRepository } from './prisma-business-activity.repository';
import { PrismaBusinessActivityReader } from './prisma-business-activity.reader';
import { TOPIC_REPOSITORY, type TopicRepository } from '../application/ports/topic.repository';
import { TOPIC_READER, type TopicReader } from '../application/ports/topic.reader';
import { PrismaTopicRepository } from './prisma-topic.repository';
import { PrismaTopicReader } from './prisma-topic.reader';
import { PrismaBrandRepository } from './prisma-brand.repository';
import { PrismaBrandReader } from './prisma-brand.reader';
import { PrismaAdminCategoryReader } from './prisma-admin-category.reader';
import { PrismaCategoryEditStore } from './prisma-category-edit.store';
import { PrismaCategoryImageStore } from './prisma-category-image.store';
import {
  CATEGORY_IMAGE_STORE,
  type CategoryImageStore,
} from '../application/ports/category-image.store';
import {
  CATEGORY_EDIT_STORE,
  CATEGORY_RESTRUCTURE_STORE,
  type CategoryEditStore,
  type CategoryRestructureStore,
} from '../application/ports/category-edit.store';
import {
  ADMIN_CATEGORY_READER,
  type AdminCategoryReader,
} from '../application/ports/admin-category.reader';
import { PrismaBrandAssigner } from './prisma-brand.assigner';

const CATALOG_SECRET = Symbol('CATALOG_SECRET');

/**
 * Binds the ports of slices 1 to 3. They live in `infrastructure/` because only this layer may reach
 * `PrismaService` (dependency-cruiser `persistence-internals-are-private`).
 */
import {
  VARIANT_ADMIN_READER,
  type VariantAdminReader,
} from '../application/ports/variant-admin.reader';
import {
  VARIANT_TYPE_SETTINGS_STORE,
  type VariantTypeSettingsStore,
} from '../application/ports/variant-type-settings.store';
import { PrismaVariantAdminReader } from './prisma-variant-admin.reader';
import { PrismaVariantTypeSettingsStore } from './prisma-variant-type-settings.store';

import { ModelGateway } from '../../../platform/ai/model-gateway';
import { SETTINGS_FACADE, type SettingsFacade } from '../../settings';
import {
  DESCRIPTION_WRITER_MODEL,
  DESCRIPTION_WRITER_SWITCHES,
  MARKET_DAY_CALENDAR,
  type DescriptionWriterModel,
  type DescriptionWriterSwitches,
  type MarketDayCalendar,
} from '../application/ports/description-writer';
import { FacadeDescriptionWriterSwitches } from './description-writer-switches';
import { GatewayDescriptionWriterModel } from './gateway-description-writer-model';
import { RegistryMarketDayCalendar } from './registry-market-day-calendar';

export const catalogProviders: readonly Provider[] = [
  {
    provide: DESCRIPTION_WRITER_MODEL,
    inject: [ModelGateway],
    useFactory: (gateway: ModelGateway): DescriptionWriterModel =>
      new GatewayDescriptionWriterModel(gateway),
  },
  {
    provide: DESCRIPTION_WRITER_SWITCHES,
    inject: [SETTINGS_FACADE, SELLERS_FACADE],
    useFactory: (settings: SettingsFacade, sellers: SellersFacade): DescriptionWriterSwitches =>
      new FacadeDescriptionWriterSwitches(settings, sellers),
  },
  {
    provide: MARKET_DAY_CALENDAR,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): MarketDayCalendar =>
      new RegistryMarketDayCalendar(markets),
  },
  // ADR-0031 decision 3: the binding of `certification.matchClaimTerms` (the placeholder is gone).
  {
    provide: CLAIM_TEXT_MATCHER,
    inject: [CERTIFICATION_FACADE],
    useFactory: (certification: CertificationFacade): ClaimTextMatcher =>
      new CertificationClaimTextMatcher(certification),
  },
  {
    provide: CATEGORY_RETIREMENT_CHECK,
    inject: [CERTIFICATION_FACADE],
    useFactory: (certification: CertificationFacade): CategoryRetirementCheck =>
      new CertificationCategoryRetirement(certification),
  },
  {
    provide: CLAIM_TERM_LOCALES,
    inject: [CERTIFICATION_FACADE],
    useFactory: (certification: CertificationFacade): ClaimTermLocales =>
      new CertificationClaimTermLocales(certification),
  },
  {
    provide: ATTRIBUTE_DEFINITION_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AttributeDefinitionStore =>
      new PrismaAttributeDefinitionStore(prisma),
  },
  {
    provide: FEATURE_SET_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): FeatureSetStore => new PrismaFeatureSetStore(prisma),
  },
  {
    provide: CATEGORY_ATTRIBUTE_LINK_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CategoryAttributeLinkStore =>
      new PrismaCategoryAttributeLinkStore(prisma),
  },
  {
    provide: ATTRIBUTE_RELAXATION_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AttributeRelaxationStore =>
      new PrismaAttributeRelaxationStore(prisma),
  },
  {
    provide: ATTRIBUTE_VALUE_SUGGESTION_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AttributeValueSuggestionStore =>
      new PrismaAttributeValueSuggestionStore(prisma),
  },
  {
    provide: TOPIC_SUGGESTION_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): TopicSuggestionStore =>
      new PrismaTopicSuggestionStore(prisma),
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
    provide: BRAND_REPOSITORY,
    inject: [PrismaService, ID_GENERATOR],
    useFactory: (prisma: PrismaService, ids: IdGenerator): BrandRepository =>
      new PrismaBrandRepository(prisma, ids),
  },
  {
    provide: ADMIN_CATEGORY_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AdminCategoryReader =>
      new PrismaAdminCategoryReader(prisma),
  },
  {
    provide: CATEGORY_EDIT_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CategoryEditStore => new PrismaCategoryEditStore(prisma),
  },
  {
    provide: CATEGORY_IMAGE_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CategoryImageStore => new PrismaCategoryImageStore(prisma),
  },
  {
    // The same store class: the restructure facts read the same tables in the same unit.
    provide: CATEGORY_RESTRUCTURE_STORE,
    inject: [CATEGORY_EDIT_STORE],
    useFactory: (store: PrismaCategoryEditStore): CategoryRestructureStore => store,
  },
  {
    provide: BRAND_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BrandReader => new PrismaBrandReader(prisma),
  },
  {
    provide: ATTRIBUTE_ADMIN_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AttributeAdminReader =>
      new PrismaAttributeAdminReader(prisma),
  },
  {
    provide: ATTRIBUTE_IMPACT_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AttributeImpactReader =>
      new PrismaAttributeImpactReader(prisma),
  },
  {
    provide: PRODUCT_DETAILS_GAP_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ProductDetailsGapReader =>
      new PrismaProductDetailsGapReader(prisma),
  },
  {
    provide: BUSINESS_ACTIVITY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BusinessActivityRepository =>
      new PrismaBusinessActivityRepository(prisma),
  },
  {
    provide: BUSINESS_ACTIVITY_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BusinessActivityReader =>
      new PrismaBusinessActivityReader(prisma),
  },
  {
    provide: TOPIC_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): TopicRepository => new PrismaTopicRepository(prisma),
  },
  {
    provide: TOPIC_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): TopicReader => new PrismaTopicReader(prisma),
  },
  {
    provide: CULTURE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CultureRepository => new PrismaCultureRepository(prisma),
  },
  {
    provide: CULTURE_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CultureReader => new PrismaCultureReader(prisma),
  },
  {
    provide: BRAND_ASSIGNER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BrandAssigner => new PrismaBrandAssigner(prisma),
  },
  {
    provide: OFFER_REPOSITORY,
    inject: [PrismaService, ID_GENERATOR],
    useFactory: (prisma: PrismaService, ids: IdGenerator): OfferRepository =>
      new PrismaOfferRepository(prisma, ids),
  },
  {
    provide: OFFER_SELL_UNIT_REPOSITORY,
    inject: [PrismaService, ID_GENERATOR],
    useFactory: (prisma: PrismaService, ids: IdGenerator): OfferSellUnitRepository =>
      new PrismaOfferSellUnitRepository(prisma, ids),
  },
  {
    provide: OFFER_LISTINGS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferListingsReader =>
      new PrismaOfferListingsReader(prisma),
  },
  {
    provide: PUBLISHED_PRODUCT_READER,
    inject: [PrismaService, CATALOG_MARKET_POLICY],
    useFactory: (prisma: PrismaService, policy: CatalogMarketPolicy): PublishedProductReader =>
      new PrismaPublishedProductReader(prisma, (market) => policy.units(market)),
  },
  {
    provide: VARIANT_GTIN_REGISTRY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): VariantGtinRegistry =>
      new PrismaVariantGtinRegistry(prisma),
  },
  {
    provide: PUBLISHED_IMAGES_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PublishedImagesReader =>
      new PrismaPublishedImagesReader(prisma),
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
  // The "Email sellers" requests of the Missing details report (attributes package A4-4).
  {
    provide: MISSING_DETAILS_EMAIL_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): MissingDetailsEmailStore =>
      new PrismaMissingDetailsEmailStore(prisma),
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
    provide: ADMIN_PRODUCTS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AdminProductsReader =>
      new PrismaAdminProductsReader(prisma),
  },
  {
    provide: ADMIN_VARIANTS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AdminVariantsReader =>
      new PrismaAdminVariantsReader(prisma),
  },
  {
    provide: CUSTOM_VARIANT_LABELS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CustomVariantLabelsReader =>
      new PrismaCustomVariantLabelsReader(prisma),
  },
  {
    provide: SAVED_FILTER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SavedFilterRepository =>
      new PrismaSavedFilterRepository(prisma),
  },
  {
    provide: SELLER_SAVED_FILTER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerSavedFilterRepository =>
      new PrismaSellerSavedFilterRepository(prisma),
  },
  cultureMembersProvider,
  // The sources of the culture visibility rule (multi-culture package 3a).
  {
    provide: SELLER_MEMBER_CULTURES,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerMemberCultures =>
      new SellersMemberCultures(sellers),
  },
  {
    provide: SELLER_CERTIFICATE_TYPES,
    inject: [CERTIFICATION_FACADE],
    useFactory: (certification: CertificationFacade): SellerCertificateTypes =>
      new CertificationSellerCertificateTypes(certification),
  },
  {
    provide: SELLER_ELIGIBILITY_READER,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerEligibilityReader =>
      new SellersSellerEligibilityReader(sellers),
  },
  {
    provide: SELLER_ELIGIBILITY_STATUS_READER,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerEligibilityStatusReader =>
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
    provide: SELLER_PRODUCT_OWNERS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerProductOwnersReader =>
      new PrismaSellerProductOwnersReader(prisma),
  },
  {
    provide: PRODUCT_LINKING_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ProductLinkingReader =>
      new PrismaProductLinkingReader(prisma),
  },
  {
    provide: CATEGORY_TREE_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CategoryTreeReader => new PrismaCategoryTreeReader(prisma),
  },
  {
    provide: PUBLIC_CATEGORY_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PublicCategoryReader =>
      new PrismaPublicCategoryReader(prisma),
  },
  {
    provide: PRODUCT_SELL_UNIT_FACTS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ProductSellUnitFactsReader =>
      new PrismaProductSellUnitFactsReader(prisma),
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
    provide: SEARCH_FILTER_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SearchFilterReader => new PrismaSearchFilterReader(prisma),
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
    provide: CULTURE_SEED,
    useFactory: (): CultureSeed => new CheckedInCultureSeed(),
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
    provide: PLATFORM_IMPORT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PlatformImportRepository =>
      new PrismaPlatformImportRepository(prisma),
  },
  {
    provide: SELLER_IMPORT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerImportRepository =>
      new PrismaSellerImportRepository(prisma),
  },
  {
    provide: SELLER_IMPORT_FACTS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerImportFactsReader =>
      new PrismaSellerImportFactsReader(prisma),
  },
  {
    provide: IMPORT_FILE_STORE,
    inject: [OBJECT_STORE],
    useFactory: (store: ObjectStore): ImportFileStore => new ObjectImportFileStore(store),
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
    // CSV is read by the domain; XLSX by exceljs, behind the container checks (catalog 14a).
    provide: IMPORT_FILE_PARSERS,
    useFactory: (): ImportFileParsers => [csvParser, xlsxParser],
  },
  {
    provide: SHEET_WRITER,
    useFactory: (): SheetWriter => new ExceljsSheetWriter(),
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
  {
    provide: VARIANT_ADMIN_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): VariantAdminReader => new PrismaVariantAdminReader(prisma),
  },
  {
    provide: VARIANT_TYPE_SETTINGS_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): VariantTypeSettingsStore =>
      new PrismaVariantTypeSettingsStore(prisma),
  },
  {
    provide: SELLER_CATEGORY_STORE,
    inject: [PrismaService, ID_GENERATOR],
    useFactory: (prisma: PrismaService, ids: IdGenerator): SellerCategoryStore =>
      new PrismaSellerCategoryStore(prisma, ids),
  },
  {
    provide: CATEGORY_PROPOSAL_CAPABILITY,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): CategoryProposalCapability =>
      new SellersCategoryProposalCapability(sellers),
  },
  {
    provide: CATEGORY_PROPOSAL_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): CategoryProposalPolicy => {
      const policy = new ConfigCatalogMarketPolicy(markets);
      return { maxPending: (market) => policy.maxPendingCategoryProposals(market) };
    },
  },
];
