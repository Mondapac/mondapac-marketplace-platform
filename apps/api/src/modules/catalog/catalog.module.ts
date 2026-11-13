import { CertificationModule } from '../certification';
import { CatalogReferencesModule } from './infrastructure/catalog-references.module';
import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import {
  AUTHORISATION_CHECK,
  JOB_CALL_CONTEXTS,
  registerPermissions,
  registerStepUpActions,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { ExtensionPointRegistry } from '../../platform/extensions';
import { ContentFilter } from '../../platform/content-filter/content-filter';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import {
  ATTRIBUTE_REPOSITORY,
  type AttributeRepository,
} from './application/ports/attribute.repository';
import { ATTRIBUTE_SEED } from './application/ports/attribute-seed';
import {
  CATALOG_MARKET_POLICY,
  type CatalogMarketPolicy,
} from './application/ports/catalog-market-policy';
import { CLAIM_TEXT_MATCHER } from './application/ports/claim-text-matcher';
import {
  PRODUCT_REVISION_REPOSITORY,
  type ProductRevisionRepository,
} from './application/ports/product-revision.repository';
import {
  PRODUCT_TYPE_LOOKUP,
  type ProductTypeLookup,
} from './application/ports/product-type-lookup';
import { ALLOWED_PRODUCT_TYPES_READER } from './application/ports/allowed-product-types.reader';
import { OFFER_REPOSITORY } from './application/ports/offer.repository';
import { OFFER_SELL_UNIT_REPOSITORY } from './application/ports/offer-sell-unit.repository';
import { OwnOfferSetSellUnits } from './application/use-cases/own-offer-set-sell-units.use-case';
import { OWN_OFFER_FINDER } from './application/ports/own-offer-finder';
import { CLAIM_EVALUATOR } from './application/ports/claim-evaluator';
import { CATEGORY_PATHS_READER } from './application/ports/category-paths.reader';
import { ClaimQueryBuilder } from './application/tags/claim-query-builder';
import { OwnOfferAddTag } from './application/use-cases/own-offer-add-tag.use-case';
import { OwnOfferRemoveTag } from './application/use-cases/own-offer-remove-tag.use-case';
import {
  SELLER_ELIGIBILITY_READER,
  SELLER_ELIGIBILITY_STATUS_READER,
} from './application/ports/seller-eligibility.reader';
import { SELLER_NAMES_READER } from './application/ports/seller-names.reader';
import { ProductRevisionApprove } from './application/use-cases/product-revision-approve.use-case';
import { ProductRevisionRequestChanges } from './application/use-cases/product-revision-request-changes.use-case';
import { ProductRevisionAdminRead } from './application/use-cases/revision-review-read.use-case';
import { ProductReviewController } from './presentation/product-review.controller';
import { OwnOfferCreateOnPlatformProduct } from './application/use-cases/own-offer-create-on-platform-product.use-case';
import { OfferApprove } from './application/use-cases/offer-approve.use-case';
import { OfferRequestChanges } from './application/use-cases/offer-request-changes.use-case';
import { OwnOfferDelete } from './application/use-cases/own-offer-delete.use-case';
import { OwnOfferEdit } from './application/use-cases/own-offer-edit.use-case';
import { OwnOfferSetHandling } from './application/use-cases/own-offer-set-handling.use-case';
import { OwnOfferRecordAttestation } from './application/use-cases/own-offer-record-attestation.use-case';
import { OwnOfferSubmit } from './application/use-cases/own-offer-submit.use-case';
import { ReviewQueueList } from './application/use-cases/review-queue-list.use-case';
import { AdminCustomVariantLabels } from './application/use-cases/admin-custom-variant-labels.use-case';
import { CUSTOM_VARIANT_LABELS_READER } from './application/ports/custom-variant-labels.reader';
import { AdminCustomVariantLabelsController } from './presentation/admin-custom-variant-labels.controller';
import { AdminProductsList } from './application/use-cases/admin-products-list.use-case';
import { ADMIN_PRODUCTS_READER } from './application/ports/admin-products.reader';
import { ADMIN_VARIANTS_READER } from './application/ports/admin-variants.reader';
import { AdminProductListController } from './presentation/admin-product-list.controller';
import { AdminProductBulkController } from './presentation/admin-product-bulk.controller';
import { AdminProductPause } from './application/use-cases/admin-product-pause.use-case';
import { IMPORT_FILE_STORE } from './application/ports/import-file-store';
import { PLATFORM_IMPORT_REPOSITORY } from './application/ports/platform-import.repository';
import { PlatformImportDiscard } from './application/use-cases/platform-import-discard.use-case';
import { PlatformImportResume } from './application/use-cases/platform-import-resume.use-case';
import { PlatformImportStart } from './application/use-cases/platform-import-start.use-case';
import { PlatformImportCheck } from './application/use-cases/platform-import-check.use-case';
import { PlatformImportRead } from './application/use-cases/platform-import-read.use-case';
import { PlatformImportReport } from './application/use-cases/platform-import-report.use-case';
import { PlatformImportTemplate } from './application/use-cases/platform-import-template.use-case';
import { PlatformImportPurge } from './application/use-cases/platform-import-purge.use-case';
import { PlatformImportRowSave } from './application/use-cases/platform-import-row-save.use-case';
import { PlatformImportRowSubmit } from './application/use-cases/platform-import-row-submit.use-case';
import { PlatformImportRun } from './application/use-cases/platform-import-run.use-case';
import { PlatformImportController } from './presentation/platform-import.controller';
import { SellerImportController } from './presentation/seller-import.controller';
import { ownImportRunJob } from './presentation/jobs/own-import-run.job';
import { purgeSellerImportsJob } from './presentation/jobs/purge-seller-imports.job';
import { SELLER_IMPORT_REPOSITORY } from './application/ports/seller-import.repository';
import { SELLER_IMPORT_FACTS_READER } from './application/ports/seller-import-facts.reader';
import { OwnImportAddPhoto } from './application/use-cases/own-import-add-photo.use-case';
import { OwnImportCheck } from './application/use-cases/own-import-check.use-case';
import { OwnImportDiscard } from './application/use-cases/own-import-discard.use-case';
import { OwnImportResume } from './application/use-cases/own-import-resume.use-case';
import { OwnImportStart } from './application/use-cases/own-import-start.use-case';
import { OwnImportPurge } from './application/use-cases/own-import-purge.use-case';
import { OwnImportRead } from './application/use-cases/own-import-read.use-case';
import { OwnImportReport } from './application/use-cases/own-import-report.use-case';
import { OwnImportTemplate } from './application/use-cases/own-import-template.use-case';
import { OwnImportRowCreate } from './application/use-cases/own-import-row-create.use-case';
import { OwnImportRowOfferCreate } from './application/use-cases/own-import-row-offer-create.use-case';
import { OwnImportRowOfferEdit } from './application/use-cases/own-import-row-offer-edit.use-case';
import { OwnImportRowSave } from './application/use-cases/own-import-row-save.use-case';
import { OwnImportRun } from './application/use-cases/own-import-run.use-case';
import { platformImportRunJob } from './presentation/jobs/platform-import-run.job';
import { purgePlatformImportsJob } from './presentation/jobs/purge-platform-imports.job';
import { AdminProductResume } from './application/use-cases/admin-product-resume.use-case';
import { AdminProductWithdraw } from './application/use-cases/admin-product-withdraw.use-case';
import { PlatformProductRetire } from './application/use-cases/platform-product-retire.use-case';
import { AdminProductsBulk } from './application/use-cases/admin-products-bulk.use-case';
import { AdminProductsExport } from './application/use-cases/admin-products-export.use-case';
import { SAVED_FILTER_REPOSITORY } from './application/ports/saved-filter.repository';
import { SELLER_SAVED_FILTER_REPOSITORY } from './application/ports/seller-saved-filter.repository';
import { OwnSavedFilterCreate } from './application/use-cases/own-saved-filter-create.use-case';
import { OwnSavedFilterDelete } from './application/use-cases/own-saved-filter-delete.use-case';
import { OwnSavedFilterShareCheck } from './application/use-cases/own-saved-filter-share-check.use-case';
import { OwnSavedFilterUpdate } from './application/use-cases/own-saved-filter-update.use-case';
import { OwnSavedFiltersList } from './application/use-cases/own-saved-filters-list.use-case';
import { SellerSavedFilterController } from './presentation/seller-saved-filter.controller';
import { SavedFilterCreate } from './application/use-cases/saved-filter-create.use-case';
import { SavedFilterDelete } from './application/use-cases/saved-filter-delete.use-case';
import { SavedFilterShareCheck } from './application/use-cases/saved-filter-share-check.use-case';
import { SavedFilterUpdate } from './application/use-cases/saved-filter-update.use-case';
import { SavedFiltersList } from './application/use-cases/saved-filters-list.use-case';
import { SavedFilterController } from './presentation/saved-filter.controller';
import { CATALOG_AUDIT_ACTIONS } from './domain/audit';
import { OFFER_SEARCH_FACTS_READER } from './application/ports/offer-search-facts.reader';
import { SEARCH_FILTER_READER } from './application/ports/search-filter.reader';
import { SearchFiltersQuery } from './application/use-cases/search-filters.use-case';
import { CATALOG_FILTERS_FACADE } from './contracts/catalog-filters.facade';
import { CatalogFiltersFacadeImplementation } from './presentation/catalog-filters.facade';
import { OFFER_TAX_CATEGORIES_READER } from './application/ports/offer-tax-categories.reader';
import { PENDING_PRODUCT_REVISIONS_READER } from './application/ports/pending-product-revisions.reader';
import { OfferTaxCategoriesQuery } from './application/use-cases/offer-tax-categories.use-case';
import { PendingProductRevisionsQuery } from './application/use-cases/pending-product-revisions.use-case';
import { PRODUCT_LINKING_READER } from './application/ports/product-linking.reader';
import { ProductsForLinkingQuery } from './application/use-cases/products-for-linking.use-case';
import { SELLER_PRODUCT_OWNERS_READER } from './application/ports/seller-product-owners.reader';
import { SellerProductOwnersQuery } from './application/use-cases/seller-product-owners.use-case';
import { CATEGORY_TREE_READER } from './application/ports/category-tree.reader';
import { CategoryTreeQuery } from './application/use-cases/category-tree.use-case';
import { CategorySlugResolveQuery } from './application/use-cases/category-slug-resolve.use-case';
import { PublicCategoryTreeQuery } from './application/use-cases/public-category-tree.use-case';
import { PUBLIC_CATEGORY_READER } from './application/ports/public-category.reader';
import { PublicCategoryController } from './presentation/public-category.controller';
import { SELL_UNIT_LABELS_READER } from './application/ports/sell-unit-labels.reader';
import { SellUnitLabelsQuery } from './application/use-cases/sell-unit-labels.use-case';
import { OFFER_NAMES_READER } from './application/ports/offer-names.reader';
import { OfferNamesSystemQuery } from './application/use-cases/offer-names-system.use-case';
import { OFFER_SELL_UNITS_READER } from './application/ports/offer-sell-units.reader';
import { SellersModule } from '../sellers';
import { PRODUCT_REPOSITORY } from './application/ports/product.repository';
import { RATE_COUNTER_KEYS } from './application/ports/rate-counter-keys';
import { RATE_COUNTER_REPOSITORY } from './application/ports/rate-counter.repository';
import { WORKING_COPY_REPOSITORY } from './application/ports/working-copy.repository';
import { CheckClaimText } from './application/claim-text/check-claim-text.service';
import { FreezeRevision } from './application/revisions/freeze-revision.service';
import { ProductFamilyResolver } from './application/attributes/product-family-resolver';
import { SubmitProduct } from './application/revisions/submit-product.service';
import { SaveDraft } from './application/working-copy/save-draft.service';
import { SaveWorkingCopy } from './application/working-copy/save-working-copy.service';
import { PlatformProductOptions } from './application/use-cases/platform-product-options.use-case';
import { PlatformProductDiscard } from './application/use-cases/platform-product-discard.use-case';
import { PlatformProductRead } from './application/use-cases/platform-product-read.use-case';
import { PlatformProductCreate } from './application/use-cases/platform-product-create.use-case';
import { PlatformProductSaveDraft } from './application/use-cases/platform-product-save-draft.use-case';
import { PlatformProductSubmit } from './application/use-cases/platform-product-submit.use-case';
import { AddSizes } from './application/products/add-sizes.service';
import { PlatformProductAddSizes } from './application/use-cases/platform-product-add-sizes.use-case';
import { PlatformProductAddSizesImpact } from './application/use-cases/platform-product-add-sizes-impact.use-case';
import { OwnProductAddSizes } from './application/use-cases/own-product-add-sizes.use-case';
import { CATALOG_PERMISSIONS } from './contracts/permissions';
import { CATALOG_STEP_UP_ACTIONS } from './contracts/step-up';
import { CATEGORY_SEED } from './application/ports/category-seed';
import { PLATFORM_CATEGORY_REPOSITORY } from './application/ports/platform-category.repository';
import { SeedAttributes } from './application/use-cases/seed-attributes.use-case';
import { OfferSearchFactsQuery } from './application/use-cases/offer-search-facts.use-case';
import { PublishedOfferIdsQuery } from './application/use-cases/published-offer-ids.use-case';
import { OfferSellUnitsSystemQuery } from './application/use-cases/offer-sell-units-system.use-case';
import { OfferSellUnitsQuery } from './application/use-cases/offer-sell-units.use-case';
import { SeedCategoryTree } from './application/use-cases/seed-category-tree.use-case';
import { CATALOG_ASSISTANT_FACADE } from './contracts/catalog-assistant.facade';
import { CATALOG_FACADE } from './contracts/catalog.facade';
import { CATALOG_ACTIVITIES_FACADE } from './contracts/catalog-activities.facade';
import { CATALOG_CULTURES_FACADE } from './contracts/catalog-cultures.facade';
import { CatalogCulturesFacadeImplementation } from './presentation/catalog-cultures.facade';
import { ActiveCulturesQuery } from './application/use-cases/active-cultures.use-case';
import { ActiveCulturesSystemQuery } from './application/use-cases/active-cultures-system.use-case';
import { CulturesByIdsQuery } from './application/use-cases/cultures-by-ids.use-case';
import { CulturesByIdsSystemQuery } from './application/use-cases/cultures-by-ids-system.use-case';
import { OfferCultureVisibility } from './application/use-cases/offer-culture-visibility.use-case';
import { OfferCultureVisibilitySystem } from './application/use-cases/offer-culture-visibility-system.use-case';
import {
  SELLER_CERTIFICATE_TYPES,
  SELLER_MEMBER_CULTURES,
} from './application/ports/culture-visibility-sources';
import { CatalogActivitiesFacadeImplementation } from './presentation/catalog-activities.facade';
import { BusinessActivitiesActiveQuery } from './application/use-cases/business-activities-active.use-case';
import { CatalogAssistantFacadeImplementation } from './presentation/catalog-assistant.facade';
import { CATALOG_INDEX_FACADE } from './contracts/catalog-index.facade';
import { CATALOG_EVENTS } from './domain/events';
import {
  PRODUCT_TYPE_POINT,
  isProductTypeHandler,
  type ProductTypeHandler,
} from './domain/product-type-handler';
import { configurableProductType } from './domain/product-types/configurable';
import { simpleProductType } from './domain/product-types/simple';
import { PlatformProductController } from './presentation/platform-product.controller';
import { OfferReviewController } from './presentation/offer-review.controller';
import { OwnOfferController } from './presentation/own-offer.controller';
import { OwnProductsExport } from './application/use-cases/own-products-export.use-case';
import { OwnProductsList } from './application/use-cases/own-products-list.use-case';
import { OwnProductRead } from './application/use-cases/own-product-read.use-case';
import { OwnOffersList } from './application/use-cases/own-offers-list.use-case';
import { OwnOfferReadSellUnits } from './application/use-cases/own-offer-read-sell-units.use-case';
import { PRODUCT_SELL_UNIT_FACTS_READER } from './application/ports/product-sell-unit-facts.reader';
import { OwnOfferRead } from './application/use-cases/own-offer-read.use-case';
import { OWN_CATALOG_READER } from './application/ports/own-catalog.reader';
import {
  PRODUCT_IMAGE_REPOSITORY,
  type ProductImageRepository,
} from './application/ports/product-image.repository';
import { IMAGE_PROCESSOR } from './application/ports/image-processor';
import { IMPORT_FILE_PARSERS } from './application/ports/import-file-parsers';
import { SHEET_WRITER } from './application/ports/sheet-writer';
import { OBJECT_STORE } from '../../platform/storage/object-store';
import { TAG_REEVALUATION_REQUESTS } from './application/ports/tag-reevaluation-requests';
import { TAG_SELECTION_READER } from './application/ports/tag-selection.reader';
import { OwnOfferRemoveSuspendedTag } from './application/use-cases/own-offer-remove-suspended-tag.use-case';
import { ReconcileTags } from './application/use-cases/reconcile-tags.use-case';
import { ReevaluateFromCertification } from './application/use-cases/reevaluate-from-certification.use-case';
import { reconcileTagsJob } from './presentation/jobs/reconcile-tags.job';
import { certificationSubscriptions } from './presentation/subscribers/certification.subscriptions';
import { certificateExpiryNoticeSubscriptions } from './presentation/subscribers/certificate-expiry-notice.subscriptions';
import { WarnOfferOwnersOfExpiry } from './application/use-cases/warn-offer-owners-of-expiry.use-case';
import { SendOfferOwnerNotices } from './application/use-cases/send-offer-owner-notices.use-case';
import { OFFER_OWNER_NOTICES } from './application/ports/offer-owner-notice.repository';
import { sendOfferOwnerNoticesJob } from './presentation/jobs/send-offer-owner-notices.job';
import {
  OFFER_OWNER_CONTACT,
  OFFER_OWNER_MAIL_SETTINGS,
  type OfferOwnerContact,
  type OfferOwnerMailSettings,
} from './application/ports/offer-owner-notices';
import {
  ConfigOfferOwnerMailSettings,
  IdentityOfferOwnerContact,
} from './infrastructure/offer-owner-notices';
import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import { MAIL_TRANSPORT } from '../../platform/mail/mail-transport';
import { MissingDetailsEmailSellers } from './application/use-cases/missing-details-email-sellers.use-case';
import { SendMissingDetailsEmails } from './application/use-cases/send-missing-details-emails.use-case';
import { sendMissingDetailsEmailsJob } from './presentation/jobs/send-missing-details-emails.job';
import { MISSING_DETAILS_EMAIL_STORE } from './application/ports/missing-details-email.store';
import {
  MISSING_DETAILS_MAIL_SETTINGS,
  type MissingDetailsMailSettings,
} from './application/ports/missing-details-mail-settings';
import { ConfigMissingDetailsMailSettings } from './infrastructure/offer-owner-notices';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OwnProductImageUpload } from './application/use-cases/own-product-image-upload.use-case';
import { OwnProductImageList } from './application/use-cases/own-product-image-list.use-case';
import { OwnProductImageRead } from './application/use-cases/own-product-image-read.use-case';
import { OwnProductImageDelete } from './application/use-cases/own-product-image-delete.use-case';
import { ProductImageController } from './presentation/product-image.controller';
import { ProductImageReviewController } from './presentation/product-image-review.controller';
import { ProductImageAdminRead } from './application/use-cases/product-image-admin-read.use-case';
import { PlatformProductImageDelete } from './application/use-cases/platform-product-image-delete.use-case';
import { PlatformProductImageList } from './application/use-cases/platform-product-image-list.use-case';
import { PlatformProductImageUpload } from './application/use-cases/platform-product-image-upload.use-case';
import { PlatformProductImageController } from './presentation/platform-product-image.controller';
import { ProductImageTakeDown } from './application/use-cases/product-image-take-down.use-case';
import { ProductRevisionImageList } from './application/use-cases/product-revision-image-list.use-case';
import { ReprocessImageFormats } from './application/use-cases/reprocess-image-formats.use-case';
import { SweepOrphanImageFiles } from './application/use-cases/sweep-orphan-image-files.use-case';
import { SweepOrphanImages } from './application/use-cases/sweep-orphan-images.use-case';
import { sweepOrphanImageFilesJob } from './presentation/jobs/sweep-orphan-image-files.job';
import { sweepOrphanImagesJob } from './presentation/jobs/sweep-orphan-images.job';
import { ReevaluateTags } from './application/use-cases/reevaluate-tags.use-case';
import { OfferBadgesQuery } from './application/use-cases/offer-badges.use-case';
import { OfferListingsQuery } from './application/use-cases/offer-listings.use-case';
import { OfferListingsSystemQuery } from './application/use-cases/offer-listings-system.use-case';
import { OFFER_LISTINGS_READER } from './application/ports/offer-listings.reader';
import { PublishedProductQuery } from './application/use-cases/published-product.use-case';
import { PUBLISHED_PRODUCT_READER } from './application/ports/published-product.reader';
import { VARIANT_GTIN_REGISTRY } from './application/ports/variant-gtin.registry';
import { PUBLISHED_IMAGES_READER } from './application/ports/published-images.reader';
import { PublishedProductImagesQuery } from './application/use-cases/published-product-images.use-case';
import { PublishedImageRead } from './application/use-cases/published-image-read.use-case';
import { PublicProductImageController } from './presentation/public-product-image.controller';
import { reevaluateTagsJob } from './presentation/jobs/reevaluate-tags.job';
import { OwnProductController } from './presentation/own-product.controller';
import { OwnTopicController } from './presentation/own-topic.controller';
import { OwnTopicList } from './application/use-cases/own-topic-list.use-case';
import { OwnProductCreate } from './application/use-cases/own-product-create.use-case';
import { OwnProductOptions } from './application/use-cases/own-product-options.use-case';
import { OwnProductSaveDraft } from './application/use-cases/own-product-save-draft.use-case';
import { OwnProductSetOwnBrand } from './application/use-cases/own-product-set-own-brand.use-case';
import { OwnProductSubmit } from './application/use-cases/own-product-submit.use-case';
import { BRAND_ASSIGNER } from './application/ports/brand-assigner';
import { BRAND_READER } from './application/ports/brand.reader';
import { BRAND_REPOSITORY } from './application/ports/brand.repository';
import { BrandApprove } from './application/use-cases/brand-approve.use-case';
import { BrandArchive } from './application/use-cases/brand-archive.use-case';
import { BUSINESS_ACTIVITY_READER } from './application/ports/business-activity.reader';
import { BUSINESS_ACTIVITY_REPOSITORY } from './application/ports/business-activity.repository';
import { BusinessActivityCreate } from './application/use-cases/business-activity-create.use-case';
import { BusinessActivityEdit } from './application/use-cases/business-activity-edit.use-case';
import { BusinessActivityGet } from './application/use-cases/business-activity-get.use-case';
import { BusinessActivityList } from './application/use-cases/business-activity-list.use-case';
import { CULTURE_READER } from './application/ports/culture.reader';
import { CULTURE_REPOSITORY } from './application/ports/culture.repository';
import { CULTURE_SEED } from './application/ports/culture-seed';
import { CultureCreate } from './application/use-cases/culture-create.use-case';
import { CultureEdit } from './application/use-cases/culture-edit.use-case';
import { CultureGet } from './application/use-cases/culture-get.use-case';
import { CultureList } from './application/use-cases/culture-list.use-case';
import { CultureCategoryMarks } from './application/use-cases/culture-category-marks.use-case';
import { CultureCategoryMarkSet } from './application/use-cases/culture-category-mark-set.use-case';
import { CultureCategoryMarkClear } from './application/use-cases/culture-category-mark-clear.use-case';
import { SeedCultures } from './application/use-cases/seed-cultures.use-case';
import { CultureAdminController } from './presentation/culture-admin.controller';
import { seedCulturesJob } from './presentation/jobs/seed-cultures.job';
import { BusinessActivityAdminController } from './presentation/business-activity-admin.controller';
import { TOPIC_READER, type TopicReader } from './application/ports/topic.reader';
import { TOPIC_REPOSITORY } from './application/ports/topic.repository';
import { TopicCreate } from './application/use-cases/topic-create.use-case';
import { TopicEdit } from './application/use-cases/topic-edit.use-case';
import { TopicGet } from './application/use-cases/topic-get.use-case';
import { TopicList } from './application/use-cases/topic-list.use-case';
import { TopicAdminController } from './presentation/topic-admin.controller';
import { BrandCreate } from './application/use-cases/brand-create.use-case';
import { BrandEdit } from './application/use-cases/brand-edit.use-case';
import { BrandGet } from './application/use-cases/brand-get.use-case';
import { BrandList } from './application/use-cases/brand-list.use-case';
import { BrandMerge } from './application/use-cases/brand-merge.use-case';
import { BrandMergeQueueDismiss } from './application/use-cases/brand-merge-queue-dismiss.use-case';
import { BrandMergeQueueList } from './application/use-cases/brand-merge-queue-list.use-case';
import { OwnBrandPropose } from './application/use-cases/own-brand-propose.use-case';
import { BrandProductIdsQuery } from './application/use-cases/brand-product-ids.use-case';
import { PublicBrandQuery } from './application/use-cases/public-brand.use-case';
import { PublicBrandsAzQuery } from './application/use-cases/public-brands-az.use-case';
import { BrandAdminController } from './presentation/brand-admin.controller';
import { AttributeAdminController } from './presentation/attribute-admin.controller';
import { AttributeRelaxationController } from './presentation/attribute-relaxation.controller';
import { OwnAttributeSuggestionsList } from './application/use-cases/own-attribute-suggestions-list.use-case';
import { OwnAttributeValueSuggest } from './application/use-cases/own-attribute-value-suggest.use-case';
import { AttributeSuggestionList } from './application/use-cases/attribute-suggestion-list.use-case';
import { AttributeSuggestionApprove } from './application/use-cases/attribute-suggestion-approve.use-case';
import { AttributeSuggestionMap } from './application/use-cases/attribute-suggestion-map.use-case';
import { AttributeSuggestionReject } from './application/use-cases/attribute-suggestion-reject.use-case';
import { OwnTopicSuggest } from './application/use-cases/own-topic-suggest.use-case';
import { OwnTopicSuggestionsList } from './application/use-cases/own-topic-suggestions-list.use-case';
import { TopicSuggestionList } from './application/use-cases/topic-suggestion-list.use-case';
import { TopicSuggestionApprove } from './application/use-cases/topic-suggestion-approve.use-case';
import { TopicSuggestionMap } from './application/use-cases/topic-suggestion-map.use-case';
import { TopicSuggestionReject } from './application/use-cases/topic-suggestion-reject.use-case';
import { SendTopicSuggestionNotices } from './application/use-cases/send-topic-suggestion-notices.use-case';
import { sendTopicSuggestionNoticesJob } from './presentation/jobs/send-topic-suggestion-notices.job';
import { TopicSuggestionController } from './presentation/topic-suggestion.controller';
import {
  OwnTopicSuggestController,
  OwnTopicSuggestionsController,
} from './presentation/own-topic-suggestion.controller';
import { TOPIC_SUGGESTION_STORE } from './application/ports/topic-suggestion.store';
import { SendAttributeSuggestionNotices } from './application/use-cases/send-attribute-suggestion-notices.use-case';
import { sendAttributeSuggestionNoticesJob } from './presentation/jobs/send-attribute-suggestion-notices.job';
import { AttributeSuggestionController } from './presentation/attribute-suggestion.controller';
import {
  OwnAttributeSuggestionController,
  OwnAttributeSuggestionsController,
} from './presentation/own-attribute-suggestion.controller';
import {
  ATTRIBUTE_VALUE_SUGGESTION_STORE,
  type AttributeValueSuggestionStore,
} from './application/ports/attribute-value-suggestion.store';
import { AttributeDefinitionCreate } from './application/use-cases/attribute-definition-create.use-case';
import { AttributeDefinitionEdit } from './application/use-cases/attribute-definition-edit.use-case';
import { AttributeDefinitionDiscard } from './application/use-cases/attribute-definition-discard.use-case';
import { AttributeDefinitionPublish } from './application/use-cases/attribute-definition-publish.use-case';
import { AttributeRelaxationRequestCreate } from './application/use-cases/attribute-relaxation-request.use-case';
import { AttributeRelaxationConfirm } from './application/use-cases/attribute-relaxation-confirm.use-case';
import { AttributeRelaxationCancel } from './application/use-cases/attribute-relaxation-cancel.use-case';
import { AttributeArchiveRequestListOpen } from './application/use-cases/attribute-archive-request-list-open.use-case';
import { AttributeRelaxationListOpen } from './application/use-cases/attribute-relaxation-list-open.use-case';
import { ExpireRelaxationRequests } from './application/use-cases/expire-relaxation-requests.use-case';
import { expireRelaxationRequestsJob } from './presentation/jobs/expire-relaxation-requests.job';
import { ATTRIBUTE_RELAXATION_STORE } from './application/ports/attribute-relaxation.store';
import { ATTRIBUTE_DEFINITION_STORE } from './application/ports/attribute-definition.store';
import { FEATURE_SET_STORE } from './application/ports/feature-set.store';
import { FeatureSetCreate } from './application/use-cases/feature-set-create.use-case';
import { FeatureSetEdit } from './application/use-cases/feature-set-edit.use-case';
import { CategoryAttributeLinksSet } from './application/use-cases/category-attribute-links-set.use-case';
import { CategoryAttributeLinksGet } from './application/use-cases/category-attribute-links-get.use-case';
import { CATEGORY_ATTRIBUTE_LINK_STORE } from './application/ports/category-attribute-link.store';
import { CULTURE_MEMBERS } from './application/ports/culture-members';
import { CLAIM_TERM_LOCALES } from './application/ports/claim-term-locales';
import { SELLER_CATEGORY_STORE } from './application/ports/seller-category.store';
import {
  CATEGORY_PROPOSAL_CAPABILITY,
  CATEGORY_PROPOSAL_POLICY,
} from './application/ports/category-proposal-capability';
import { OwnCategoryPropose } from './application/use-cases/own-category-propose.use-case';
import { OwnCategoryProposalCancel } from './application/use-cases/own-category-proposal-cancel.use-case';
import { OwnCategoryProposalsList } from './application/use-cases/own-category-proposals-list.use-case';
import { CategoryProposalList } from './application/use-cases/category-proposal-list.use-case';
import { CategoryProposalApprove } from './application/use-cases/category-proposal-approve.use-case';
import { CategoryProposalReject } from './application/use-cases/category-proposal-reject.use-case';
import { SellerCategoryAdminList } from './application/use-cases/seller-category-admin-list.use-case';
import { SellerCategoryPromote } from './application/use-cases/seller-category-promote.use-case';
import { SellerCategoryMerge } from './application/use-cases/seller-category-merge.use-case';
import { OwnOfferSetShelf } from './application/use-cases/own-offer-set-shelf.use-case';
import { CancelPendingProposals } from './application/use-cases/cancel-pending-proposals.use-case';
import { sellerCategoryProposalSubscriptions } from './presentation/subscribers/seller-category-proposals.subscriptions';
import { OwnCategoryProposalController } from './presentation/own-category-proposal.controller';
import { CategoryProposalAdminController } from './presentation/category-proposal-admin.controller';
import { AttributeAdminGet } from './application/use-cases/attribute-admin-get.use-case';
import { AttributeAdminList } from './application/use-cases/attribute-admin-list.use-case';
import { FeatureSetAdminGet } from './application/use-cases/feature-set-admin-get.use-case';
import { FeatureSetAdminList } from './application/use-cases/feature-set-admin-list.use-case';
import { ATTRIBUTE_ADMIN_READER } from './application/ports/attribute-admin.reader';
import { ATTRIBUTE_IMPACT_READER } from './application/ports/attribute-impact.reader';
import { AttributeImpactGet } from './application/use-cases/attribute-impact-get.use-case';
import { AttributeConvert } from './application/use-cases/attribute-convert.use-case';
import { AttributeMerge } from './application/use-cases/attribute-merge.use-case';
import { AttributeValuesMerge } from './application/use-cases/attribute-values-merge.use-case';
import { AttributeArchive } from './application/use-cases/attribute-archive.use-case';
import { AttributeArchiveRequestCreate } from './application/use-cases/attribute-archive-request.use-case';
import { AttributeArchiveConfirm } from './application/use-cases/attribute-archive-confirm.use-case';
import { AttributeRestructureController } from './presentation/attribute-restructure.controller';
import { PRODUCT_DETAILS_GAP_READER } from './application/ports/product-details-gap.reader';
import { ProductsMissingDetailsList } from './application/use-cases/products-missing-details-list.use-case';
import { ADMIN_CATEGORY_READER } from './application/ports/admin-category.reader';
import { CATEGORY_EDIT_STORE } from './application/ports/category-edit.store';
import { CATEGORY_IMAGE_STORE } from './application/ports/category-image.store';
import { CategoryImageRead } from './application/use-cases/category-image-read.use-case';
import { CategoryImageRemove } from './application/use-cases/category-image-remove.use-case';
import { CategoryImageSet } from './application/use-cases/category-image-set.use-case';
import { CategoryCreate } from './application/use-cases/category-create.use-case';
import { CategoryEditDetails } from './application/use-cases/category-edit-details.use-case';
import { CategoryReorder } from './application/use-cases/category-reorder.use-case';
import { CategoryHide } from './application/use-cases/category-hide.use-case';
import { CategoryMove } from './application/use-cases/category-move.use-case';
import { CategoryMerge } from './application/use-cases/category-merge.use-case';
import { CategoryArchive } from './application/use-cases/category-archive.use-case';
import { ReportRetiredCategories } from './application/use-cases/report-retired-categories.use-case';
import { categoryRetirementSubscriptions } from './presentation/subscribers/category-retirement.subscriptions';
import { CATEGORY_RESTRUCTURE_STORE } from './application/ports/category-edit.store';
import { CATEGORY_RETIREMENT_CHECK } from './application/ports/category-retirement-check';
import { CategoryShow } from './application/use-cases/category-show.use-case';
import { CategoryChangeSlug } from './application/use-cases/category-change-slug.use-case';
import { CategoryDiscard } from './application/use-cases/category-discard.use-case';
import type { CategoryActionProbes } from './application/categories/category-admin-views';
import { CategoryEditProbe } from './application/use-cases/category-edit-probe.use-case';
import { CategoryImportProbe } from './application/use-cases/category-import-probe.use-case';
import { CategoryImportDryRun } from './application/use-cases/category-import-dry-run.use-case';
import { CategoryImportApply } from './application/use-cases/category-import-apply.use-case';
import { CategoryTreeExport } from './application/use-cases/category-tree-export.use-case';
import { CategoryImportController } from './presentation/category-import.controller';
import { CategoryRestructureProbe } from './application/use-cases/category-restructure-probe.use-case';
import { CategoryAdminGet } from './application/use-cases/category-admin-get.use-case';
import { CategoryAdminTree } from './application/use-cases/category-admin-tree.use-case';
import { CategoryImpact } from './application/use-cases/category-impact.use-case';
import { CategoryAdminController } from './presentation/category-admin.controller';
import { OwnBrandController } from './presentation/own-brand.controller';
import { PublicBrandController } from './presentation/public-brand.controller';
import { catalogProviders } from './infrastructure/catalog-providers';
import { assertCatalogConfigured } from './infrastructure/market-config-boot-check';
import { seedAttributesJob } from './presentation/jobs/seed-attributes.job';
import { CatalogFacadeImplementation } from './presentation/catalog.facade';
import { SearchIndexStampQuery } from './application/use-cases/search-index-stamp.use-case';
import { CatalogIndexFacadeImplementation } from './presentation/catalog-index.facade';
import { seedCategoryTreeJob } from './presentation/jobs/seed-category-tree.job';

/**
 * The Nest token of each dependency name the use cases of catalog share: a use case's dependency
 * object is built from these by {@link useCaseProvider}, so a name always means the same port.
 */
import { VARIANT_ADMIN_READER } from './application/ports/variant-admin.reader';
import { VARIANT_TYPE_SETTINGS_STORE } from './application/ports/variant-type-settings.store';
import { AdminVariantTypeGet } from './application/use-cases/admin-variant-type-get.use-case';
import { AdminVariantTypesList } from './application/use-cases/admin-variant-types-list.use-case';
import { AdminVariantIssueCounts } from './application/use-cases/admin-variant-issue-counts.use-case';
import { AdminVariantsExport } from './application/use-cases/admin-variants-export.use-case';
import { AttributeFilesExport } from './application/use-cases/attribute-files-export.use-case';
import { AttributeImportCheck } from './application/use-cases/attribute-import-check.use-case';
import { AttributeImportRun } from './application/use-cases/attribute-import-run.use-case';
import { AttributeFileController } from './presentation/attribute-file.controller';
import { AdminVariantsList } from './application/use-cases/admin-variants-list.use-case';
import { VariantTypeSettingsEdit } from './application/use-cases/variant-type-settings-edit.use-case';
import { VariantAdminController } from './presentation/variant-admin.controller';

/** The three key probes the category reads use for their allowed actions (categories C1). */
const CATEGORY_ACTION_PROBES = Symbol('CATEGORY_ACTION_PROBES');

/**
 * The row use cases of the seller import hold the interactive use case of the same action, built
 * with a save budget that spends nothing (catalog design 14c): the import is bounded by its own
 * limits instead. These instances are private to the import and never reach a route.
 */
const OWN_IMPORT_PRODUCT_CREATE = Symbol('CATALOG_OWN_IMPORT_PRODUCT_CREATE');
const OWN_IMPORT_OFFER_CREATE = Symbol('CATALOG_OWN_IMPORT_OFFER_CREATE');
const OWN_IMPORT_OFFER_EDIT = Symbol('CATALOG_OWN_IMPORT_OFFER_EDIT');
const OWN_IMPORT_IMAGE_UPLOAD = Symbol('CATALOG_OWN_IMPORT_IMAGE_UPLOAD');
const NO_SAVE_BUDGET = { reserveSaves: (): Promise<null> => Promise.resolve(null) } as const;

const PORT = {
  unitOfWork: UNIT_OF_WORK,
  categories: PLATFORM_CATEGORY_REPOSITORY,
  seed: CATEGORY_SEED,
  attributes: ATTRIBUTE_REPOSITORY,
  attributeSeed: ATTRIBUTE_SEED,
  outbox: OUTBOX_WRITER,
  clock: CLOCK,
  ids: ID_GENERATOR,
  products: PRODUCT_REPOSITORY,
  workingCopies: WORKING_COPY_REPOSITORY,
  counters: RATE_COUNTER_REPOSITORY,
  counterKeys: RATE_COUNTER_KEYS,
  policy: CATALOG_MARKET_POLICY,
  matcher: CLAIM_TEXT_MATCHER,
  check: CheckClaimText,
  save: SaveWorkingCopy,
  saveDraft: SaveDraft,
  productTypes: PRODUCT_TYPE_LOOKUP,
  revisions: PRODUCT_REVISION_REPOSITORY,
  freeze: FreezeRevision,
  submit: SubmitProduct,
  addSizes: AddSizes,
  reader: OFFER_SELL_UNITS_READER,
  searchReader: OFFER_SEARCH_FACTS_READER,
  filterReader: SEARCH_FILTER_READER,
  namesReader: OFFER_NAMES_READER,
  labelsReader: SELL_UNIT_LABELS_READER,
  productSellUnitFacts: PRODUCT_SELL_UNIT_FACTS_READER,
  taxCategoriesReader: OFFER_TAX_CATEGORIES_READER,
  pendingRevisionsReader: PENDING_PRODUCT_REVISIONS_READER,
  productOwnersReader: SELLER_PRODUCT_OWNERS_READER,
  productLinkingReader: PRODUCT_LINKING_READER,
  treeReader: CATEGORY_TREE_READER,
  publicCategories: PUBLIC_CATEGORY_READER,
  offers: OFFER_REPOSITORY,
  sellUnits: OFFER_SELL_UNIT_REPOSITORY,
  offerFinder: OWN_OFFER_FINDER,
  claims: ClaimQueryBuilder,
  evaluator: CLAIM_EVALUATOR,
  categoryPaths: CATEGORY_PATHS_READER,
  eligibility: SELLER_ELIGIBILITY_READER,
  eligibilityStatus: SELLER_ELIGIBILITY_STATUS_READER,
  allowedTypes: ALLOWED_PRODUCT_TYPES_READER,
  sellerNames: SELLER_NAMES_READER,
  ownReader: OWN_CATALOG_READER,
  adminProductsReader: ADMIN_PRODUCTS_READER,
  adminVariantsReader: ADMIN_VARIANTS_READER,
  customVariantLabelsReader: CUSTOM_VARIANT_LABELS_READER,
  images: PRODUCT_IMAGE_REPOSITORY,
  imageProcessor: IMAGE_PROCESSOR,
  objectStore: OBJECT_STORE,
  requests: TAG_REEVALUATION_REQUESTS,
  tagSelection: TAG_SELECTION_READER,
  listingsReader: OFFER_LISTINGS_READER,
  publishedProductReader: PUBLISHED_PRODUCT_READER,
  gtinRegistry: VARIANT_GTIN_REGISTRY,
  publishedImagesReader: PUBLISHED_IMAGES_READER,
  ownerContacts: OFFER_OWNER_CONTACT,
  mailTransport: MAIL_TRANSPORT,
  mailSettings: OFFER_OWNER_MAIL_SETTINGS,
  notices: OFFER_OWNER_NOTICES,
  audit: AUDIT_WRITER,
  pause: AdminProductPause,
  resume: AdminProductResume,
  withdraw: AdminProductWithdraw,
  retire: PlatformProductRetire,
  importJobs: PLATFORM_IMPORT_REPOSITORY,
  sellerJobs: SELLER_IMPORT_REPOSITORY,
  importFacts: SELLER_IMPORT_FACTS_READER,
  ownRowCreate: OwnImportRowCreate,
  ownRowSave: OwnImportRowSave,
  ownRowOfferCreate: OwnImportRowOfferCreate,
  ownRowOfferEdit: OwnImportRowOfferEdit,
  ownImageUpload: OWN_IMPORT_IMAGE_UPLOAD,
  ownImageDelete: OwnProductImageDelete,
  importFiles: IMPORT_FILE_STORE,
  importParsers: IMPORT_FILE_PARSERS,
  sheetWriter: SHEET_WRITER,
  authorisation: AUTHORISATION_CHECK,
  jobContexts: JOB_CALL_CONTEXTS,
  platformCreate: PlatformProductCreate,
  rowSave: PlatformImportRowSave,
  rowSubmit: PlatformImportRowSubmit,
  savedFilters: SAVED_FILTER_REPOSITORY,
  shareCheck: SavedFilterShareCheck,
  sellerSavedFilters: SELLER_SAVED_FILTER_REPOSITORY,
  ownShareCheck: OwnSavedFilterShareCheck,
  brands: BRAND_REPOSITORY,
  brandReader: BRAND_READER,
  adminCategoryReader: ADMIN_CATEGORY_READER,
  store: CATEGORY_EDIT_STORE,
  categoryImages: CATEGORY_IMAGE_STORE,
  restructure: CATEGORY_RESTRUCTURE_STORE,
  retirement: CATEGORY_RETIREMENT_CHECK,
  categoryProbes: CATEGORY_ACTION_PROBES,
  attributeAdminReader: ATTRIBUTE_ADMIN_READER,
  impact: ATTRIBUTE_IMPACT_READER,
  detailsGapReader: PRODUCT_DETAILS_GAP_READER,
  emailStore: MISSING_DETAILS_EMAIL_STORE,
  missingDetailsMailSettings: MISSING_DETAILS_MAIL_SETTINGS,
  familyResolver: ProductFamilyResolver,
  attributeStore: ATTRIBUTE_DEFINITION_STORE,
  attributeCreate: AttributeDefinitionCreate,
  attributeEdit: AttributeDefinitionEdit,
  featureSetStore: FEATURE_SET_STORE,
  linkStore: CATEGORY_ATTRIBUTE_LINK_STORE,
  relaxations: ATTRIBUTE_RELAXATION_STORE,
  suggestions: ATTRIBUTE_VALUE_SUGGESTION_STORE,
  topicSuggestions: TOPIC_SUGGESTION_STORE,
  claimLocales: CLAIM_TERM_LOCALES,
  cultureMembers: CULTURE_MEMBERS,
  memberCultures: SELLER_MEMBER_CULTURES,
  certificateTypes: SELLER_CERTIFICATE_TYPES,
  brandAssigner: BRAND_ASSIGNER,
  activities: BUSINESS_ACTIVITY_REPOSITORY,
  activityReader: BUSINESS_ACTIVITY_READER,
  cultures: CULTURE_REPOSITORY,
  cultureReader: CULTURE_READER,
  cultureSeed: CULTURE_SEED,
  topics: TOPIC_REPOSITORY,
  topicReader: TOPIC_READER,
  contentFilter: ContentFilter,
  variantAdminReader: VARIANT_ADMIN_READER,
  variantTypeSettings: VARIANT_TYPE_SETTINGS_STORE,
  shelves: SELLER_CATEGORY_STORE,
  capability: CATEGORY_PROPOSAL_CAPABILITY,
  proposalPolicy: CATEGORY_PROPOSAL_POLICY,
} as const satisfies Record<string, InjectionToken>;

type PortName = keyof typeof PORT;

/**
 * The provider of one use case: the gate and the named ports, in a dependency object. `ports`
 * names every key of the use case's own dependency type, each a key of {@link PORT}, and no
 * other: the type checker refuses a missing, unknown or misnamed dependency.
 */
function useCaseProvider<D, U>(
  type: new (gate: UseCaseGate, deps: D) => U,
  ports: { readonly [K in keyof D]-?: K extends PortName ? true : never },
): FactoryProvider<U> {
  const names = Object.keys(ports) as PortName[];
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...names.map((name) => PORT[name])],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(gate, Object.fromEntries(names.map((name, index) => [name, values[index]])) as D),
  };
}

/**
 * A provider of a use case instance under a token of its own, built from the same named ports as the
 * use case's usual provider but with the dependencies the factory changes (the seller import's row
 * use cases, which hold the interactive use case with no save budget).
 */
function portVariantProvider<D, U>(
  provide: symbol,
  type: new (gate: UseCaseGate, deps: D, ...rest: never[]) => U,
  ports: { readonly [K in keyof D]-?: K extends PortName ? true : never },
  override: Partial<D>,
  extra: readonly unknown[] = [],
): FactoryProvider<U> {
  const names = Object.keys(ports) as PortName[];
  return {
    provide,
    inject: [USE_CASE_GATE, ...names.map((name) => PORT[name])],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) => {
      const deps = {
        ...Object.fromEntries(names.map((name, index) => [name, values[index]])),
        ...override,
      } as D;
      return new (type as new (...args: unknown[]) => U)(gate, deps, ...extra);
    },
  };
}

/** The provider of an internal service (no gate, no access declaration): its named ports. */
function serviceProvider<D, U>(
  type: new (deps: D) => U,
  ports: { readonly [K in keyof D]-?: K extends PortName ? true : never },
): FactoryProvider<U> {
  const names = Object.keys(ports) as PortName[];
  return {
    provide: type,
    inject: names.map((name) => PORT[name]),
    useFactory: (...values: unknown[]) =>
      new type(Object.fromEntries(names.map((name, index) => [name, values[index]])) as D),
  };
}

/**
 * Declares the point `catalog.product-type` and registers the two structural types core owns
 * (catalog design 3.1 rows 1 and 3). A Vertical's own type registers through the same call
 * from its `verticals/<vertical>/` folder. The registry is sealed when the application has
 * bootstrapped.
 */
const productTypeProvider: FactoryProvider<string> = {
  provide: Symbol('catalog.product-types'),
  inject: [ExtensionPointRegistry],
  useFactory: (registry: ExtensionPointRegistry): string => {
    registry.declarePoint<ProductTypeHandler>(PRODUCT_TYPE_POINT, 'catalog', isProductTypeHandler);
    for (const handler of [simpleProductType, configurableProductType]) {
      registry.register(PRODUCT_TYPE_POINT, handler.typeCode, handler, { module: 'catalog' });
    }
    return 'catalog';
  },
};

/**
 * The catalog bounded context (docs/design/domain/catalog.md; ADR-0013), filled slice by slice.
 * Slice 1 binds its outbox writer and events, the product store and the two structural product
 * types; slice 2 adds the category store and the seed job; its other use cases arrive with
 * slices 6 and 7.
 */
const RESTRUCTURE_DEPS = {
  unitOfWork: true,
  store: true,
  restructure: true,
  categories: true,
  policy: true,
  retirement: true,
  offers: true,
  requests: true,
  audit: true,
  outbox: true,
  clock: true,
  ids: true,
} as const;

@Module({
  controllers: [
    PlatformProductController,
    OwnOfferController,
    OwnProductController,
    OwnTopicController,
    ProductImageController,
    OfferReviewController,
    AdminProductListController,
    AdminCustomVariantLabelsController,
    VariantAdminController,
    AttributeFileController,
    AdminProductBulkController,
    PlatformImportController,
    SellerImportController,
    SavedFilterController,
    SellerSavedFilterController,
    ProductReviewController,
    ProductImageReviewController,
    PlatformProductImageController,
    PublicCategoryController,
    PublicProductImageController,
    BrandAdminController,
    AttributeAdminController,
    AttributeRelaxationController,
    AttributeRestructureController,
    AttributeSuggestionController,
    OwnAttributeSuggestionController,
    OwnAttributeSuggestionsController,
    TopicSuggestionController,
    OwnTopicSuggestController,
    OwnTopicSuggestionsController,
    CategoryAdminController,
    CategoryImportController,
    BusinessActivityAdminController,
    CultureAdminController,
    TopicAdminController,
    OwnBrandController,
    PublicBrandController,
    OwnCategoryProposalController,
    CategoryProposalAdminController,
  ],
  imports: [CertificationModule, SellersModule, CatalogReferencesModule, IdentityModule],
  providers: [
    PersistenceModule.outboxWriterFor('catalog'),
    PersistenceModule.auditWriterFor('catalog'),
    registerAuditActions('catalog', CATALOG_AUDIT_ACTIONS),
    registerEvents('catalog', CATALOG_EVENTS),
    productTypeProvider,
    {
      provide: 'CATALOG_MARKET_CONFIG_CHECK',
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry) => {
        assertCatalogConfigured(markets);
        return true;
      },
    },
    // Pushes its catalogue into the permission registry (identity slice 8a-1, PF 6.1).
    registerPermissions('catalog', CATALOG_PERMISSIONS),
    registerStepUpActions('catalog', CATALOG_STEP_UP_ACTIONS),
    ...catalogProviders,
    serviceProvider(CheckClaimText, {
      unitOfWork: true,
      matcher: true,
      counters: true,
      counterKeys: true,
      policy: true,
      clock: true,
    }),
    serviceProvider(SaveWorkingCopy, {
      unitOfWork: true,
      products: true,
      workingCopies: true,
      counters: true,
      counterKeys: true,
      policy: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    serviceProvider(SaveDraft, {
      unitOfWork: true,
      check: true,
      save: true,
      workingCopies: true,
      policy: true,
      gtinRegistry: true,
      contentFilter: true,
    }),
    {
      provide: PRODUCT_TYPE_LOOKUP,
      inject: [ExtensionPointRegistry],
      useFactory:
        (registry: ExtensionPointRegistry): ProductTypeLookup =>
        (typeCode) =>
          registry.get<ProductTypeHandler>(PRODUCT_TYPE_POINT, typeCode),
    },
    {
      provide: FreezeRevision,
      inject: [
        ATTRIBUTE_REPOSITORY,
        CATALOG_MARKET_POLICY,
        PRODUCT_TYPE_LOOKUP,
        PRODUCT_IMAGE_REPOSITORY,
        ATTRIBUTE_VALUE_SUGGESTION_STORE,
        PRODUCT_REVISION_REPOSITORY,
        ProductFamilyResolver,
        TOPIC_READER,
      ],
      useFactory: (
        attributes: AttributeRepository,
        policy: CatalogMarketPolicy,
        handlerFor: ProductTypeLookup,
        images: ProductImageRepository,
        suggestions: AttributeValueSuggestionStore,
        revisions: ProductRevisionRepository,
        familyResolver: ProductFamilyResolver,
        topics: TopicReader,
      ): FreezeRevision =>
        new FreezeRevision({
          attributes,
          familyResolver,
          policy,
          handlerFor,
          images,
          suggestions,
          revisions,
          topics,
        }),
    },
    serviceProvider(ProductFamilyResolver, {
      treeReader: true,
      linkStore: true,
      attributeAdminReader: true,
      policy: true,
    }),
    serviceProvider(ClaimQueryBuilder, { products: true, revisions: true, categoryPaths: true }),
    serviceProvider(SubmitProduct, {
      unitOfWork: true,
      products: true,
      workingCopies: true,
      revisions: true,
      freeze: true,
      check: true,
      policy: true,
      outbox: true,
      clock: true,
      ids: true,
      offers: true,
      requests: true,
      audit: true,
      brandAssigner: true,
    }),
    useCaseProvider(BusinessActivityList, {
      unitOfWork: true,
      activityReader: true,
      policy: true,
    }),
    // The activity ids that are active, for sellers' assignment check (ADR-0040 decision 4).
    useCaseProvider(BusinessActivitiesActiveQuery, { unitOfWork: true, activityReader: true }),
    {
      provide: CATALOG_ACTIVITIES_FACADE,
      inject: [BusinessActivitiesActiveQuery],
      useFactory: (active: BusinessActivitiesActiveQuery) =>
        new CatalogActivitiesFacadeImplementation(active),
    },
    useCaseProvider(BusinessActivityGet, { unitOfWork: true, activities: true }),
    useCaseProvider(BusinessActivityCreate, {
      contentFilter: true,
      unitOfWork: true,
      activities: true,
      treeReader: true,
      policy: true,
      matcher: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(BusinessActivityEdit, {
      contentFilter: true,
      unitOfWork: true,
      activities: true,
      treeReader: true,
      policy: true,
      matcher: true,
      clock: true,
    }),
    useCaseProvider(TopicList, { unitOfWork: true, topicReader: true, policy: true }),
    useCaseProvider(OwnTopicList, { unitOfWork: true, topicReader: true, policy: true }),
    useCaseProvider(TopicGet, { unitOfWork: true, topics: true }),
    useCaseProvider(TopicCreate, {
      unitOfWork: true,
      topics: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(TopicEdit, {
      unitOfWork: true,
      topics: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      clock: true,
    }),
    useCaseProvider(CultureList, { unitOfWork: true, cultureReader: true }),
    useCaseProvider(CultureGet, { unitOfWork: true, cultures: true }),
    // The culture read for sellers' membership (ADR-0047 decision 3).
    useCaseProvider(CulturesByIdsQuery, { unitOfWork: true, cultureReader: true }),
    useCaseProvider(CulturesByIdsSystemQuery, { unitOfWork: true, cultureReader: true }),
    useCaseProvider(ActiveCulturesQuery, { unitOfWork: true, cultureReader: true }),
    useCaseProvider(ActiveCulturesSystemQuery, { unitOfWork: true, cultureReader: true }),
    // The culture filter (multi-culture package 3a; ADR-0047 decisions 5 and 6).
    useCaseProvider(OfferCultureVisibility, {
      unitOfWork: true,
      offers: true,
      claims: true,
      evaluator: true,
      cultureReader: true,
      cultures: true,
      memberCultures: true,
      certificateTypes: true,
    }),
    useCaseProvider(OfferCultureVisibilitySystem, {
      unitOfWork: true,
      offers: true,
      claims: true,
      evaluator: true,
      cultureReader: true,
      cultures: true,
      memberCultures: true,
      certificateTypes: true,
    }),
    {
      provide: CATALOG_CULTURES_FACADE,
      inject: [
        CulturesByIdsQuery,
        CulturesByIdsSystemQuery,
        ActiveCulturesQuery,
        ActiveCulturesSystemQuery,
        OfferCultureVisibility,
        OfferCultureVisibilitySystem,
      ],
      useFactory: (
        byIds: CulturesByIdsQuery,
        byIdsSystem: CulturesByIdsSystemQuery,
        active: ActiveCulturesQuery,
        activeSystem: ActiveCulturesSystemQuery,
        visibility: OfferCultureVisibility,
        visibilitySystem: OfferCultureVisibilitySystem,
      ) =>
        new CatalogCulturesFacadeImplementation({
          byIds,
          byIdsSystem,
          active,
          activeSystem,
          visibility,
          visibilitySystem,
        }),
    },
    useCaseProvider(CultureCreate, {
      unitOfWork: true,
      cultures: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      evaluator: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CultureEdit, {
      unitOfWork: true,
      cultures: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      cultureMembers: true,
      evaluator: true,
      audit: true,
      clock: true,
      outbox: true,
      ids: true,
    }),
    useCaseProvider(CultureCategoryMarks, {
      unitOfWork: true,
      cultures: true,
      treeReader: true,
      policy: true,
    }),
    useCaseProvider(CultureCategoryMarkSet, {
      unitOfWork: true,
      cultures: true,
      treeReader: true,
      policy: true,
      audit: true,
      clock: true,
      outbox: true,
      ids: true,
    }),
    useCaseProvider(CultureCategoryMarkClear, {
      unitOfWork: true,
      cultures: true,
      audit: true,
      outbox: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(SeedCultures, {
      unitOfWork: true,
      cultures: true,
      cultureSeed: true,
      policy: true,
      evaluator: true,
      matcher: true,
      claimLocales: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(BrandList, { unitOfWork: true, brandReader: true }),
    useCaseProvider(AttributeAdminList, {
      unitOfWork: true,
      attributeAdminReader: true,
      policy: true,
    }),
    useCaseProvider(AttributeAdminGet, {
      unitOfWork: true,
      attributeAdminReader: true,
      policy: true,
    }),
    useCaseProvider(FeatureSetAdminList, { unitOfWork: true, attributeAdminReader: true }),
    useCaseProvider(AttributeDefinitionCreate, {
      unitOfWork: true,
      attributeStore: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeDefinitionEdit, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeRelaxationRequestCreate, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeRelaxationConfirm, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeRelaxationCancel, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeImpactGet, {
      unitOfWork: true,
      attributeStore: true,
      impact: true,
    }),
    useCaseProvider(AttributeValuesMerge, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeConvert, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeMerge, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      impact: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeArchive, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      impact: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeArchiveRequestCreate, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      impact: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeArchiveConfirm, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      impact: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AttributeArchiveRequestListOpen, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      clock: true,
    }),
    useCaseProvider(AttributeRelaxationListOpen, {
      unitOfWork: true,
      attributeStore: true,
      relaxations: true,
      clock: true,
    }),
    useCaseProvider(OwnAttributeValueSuggest, {
      unitOfWork: true,
      products: true,
      attributes: true,
      attributeStore: true,
      suggestions: true,
      workingCopies: true,
      familyResolver: true,
      eligibility: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnAttributeSuggestionsList, {
      unitOfWork: true,
      suggestions: true,
      attributeStore: true,
      products: true,
      ownReader: true,
      policy: true,
    }),
    useCaseProvider(AttributeSuggestionList, {
      unitOfWork: true,
      suggestions: true,
      attributeStore: true,
      products: true,
      policy: true,
    }),
    useCaseProvider(AttributeSuggestionApprove, {
      unitOfWork: true,
      attributeStore: true,
      suggestions: true,
      audit: true,
      clock: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      ids: true,
    }),
    useCaseProvider(AttributeSuggestionMap, {
      unitOfWork: true,
      attributeStore: true,
      suggestions: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(AttributeSuggestionReject, {
      unitOfWork: true,
      attributeStore: true,
      suggestions: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SendAttributeSuggestionNotices, {
      unitOfWork: true,
      suggestions: true,
      attributeStore: true,
      ownerContacts: true,
      mailTransport: true,
      mailSettings: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(OwnTopicSuggest, {
      unitOfWork: true,
      products: true,
      topics: true,
      topicSuggestions: true,
      eligibility: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnTopicSuggestionsList, {
      unitOfWork: true,
      topicSuggestions: true,
      topicReader: true,
      products: true,
      ownReader: true,
      policy: true,
    }),
    useCaseProvider(TopicSuggestionList, {
      unitOfWork: true,
      topicSuggestions: true,
      products: true,
      policy: true,
    }),
    useCaseProvider(TopicSuggestionApprove, {
      unitOfWork: true,
      topicSuggestions: true,
      topics: true,
      audit: true,
      clock: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      ids: true,
    }),
    useCaseProvider(TopicSuggestionMap, {
      unitOfWork: true,
      topicSuggestions: true,
      topics: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(TopicSuggestionReject, {
      unitOfWork: true,
      topicSuggestions: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SendTopicSuggestionNotices, {
      unitOfWork: true,
      topicSuggestions: true,
      topicReader: true,
      ownerContacts: true,
      mailTransport: true,
      mailSettings: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(ExpireRelaxationRequests, {
      unitOfWork: true,
      relaxations: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(AttributeDefinitionPublish, {
      unitOfWork: true,
      attributeStore: true,
      policy: true,
      audit: true,
      matcher: true,
      claimLocales: true,
    }),
    useCaseProvider(AttributeDefinitionDiscard, {
      unitOfWork: true,
      attributeStore: true,
      policy: true,
      audit: true,
    }),
    useCaseProvider(FeatureSetCreate, {
      unitOfWork: true,
      featureSetStore: true,
      attributeAdminReader: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(FeatureSetEdit, {
      unitOfWork: true,
      featureSetStore: true,
      attributeAdminReader: true,
      relaxations: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryAttributeLinksSet, {
      unitOfWork: true,
      linkStore: true,
      attributeAdminReader: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryAttributeLinksGet, {
      unitOfWork: true,
      linkStore: true,
      treeReader: true,
      attributeAdminReader: true,
    }),
    useCaseProvider(ProductsMissingDetailsList, {
      unitOfWork: true,
      detailsGapReader: true,
      attributes: true,
      policy: true,
      familyResolver: true,
      emailStore: true,
    }),
    useCaseProvider(FeatureSetAdminGet, {
      unitOfWork: true,
      attributeAdminReader: true,
      policy: true,
    }),
    ...[CategoryEditProbe, CategoryRestructureProbe, CategoryImportProbe].map(
      (probe): FactoryProvider => ({
        provide: probe,
        inject: [USE_CASE_GATE],
        useFactory: (gate: UseCaseGate) => new probe(gate),
      }),
    ),
    {
      provide: CATEGORY_ACTION_PROBES,
      inject: [CategoryEditProbe, CategoryRestructureProbe, CategoryImportProbe],
      useFactory: (
        edit: CategoryEditProbe,
        restructure: CategoryRestructureProbe,
        importing: CategoryImportProbe,
      ): CategoryActionProbes => ({ edit, restructure, importing }),
    },
    useCaseProvider(CategoryAdminTree, {
      unitOfWork: true,
      adminCategoryReader: true,
      policy: true,
      categoryProbes: true,
      linkStore: true,
      attributeAdminReader: true,
    }),
    useCaseProvider(CategoryAdminGet, {
      unitOfWork: true,
      adminCategoryReader: true,
      policy: true,
      categoryProbes: true,
    }),
    useCaseProvider(CategoryImpact, {
      unitOfWork: true,
      adminCategoryReader: true,
      linkStore: true,
    }),
    useCaseProvider(CategoryImportDryRun, {
      adminCategoryReader: true,
      contentFilter: true,
      unitOfWork: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
      importParsers: true,
    }),
    useCaseProvider(CategoryImportApply, {
      adminCategoryReader: true,
      contentFilter: true,
      unitOfWork: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
      importParsers: true,
    }),
    useCaseProvider(CategoryTreeExport, {
      unitOfWork: true,
      store: true,
      policy: true,
      sheetWriter: true,
      clock: true,
    }),
    useCaseProvider(CategoryCreate, {
      contentFilter: true,
      unitOfWork: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryEditDetails, {
      contentFilter: true,
      unitOfWork: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryReorder, {
      contentFilter: true,
      unitOfWork: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryHide, {
      contentFilter: true,
      unitOfWork: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryShow, {
      contentFilter: true,
      unitOfWork: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryChangeSlug, {
      contentFilter: true,
      unitOfWork: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryDiscard, {
      contentFilter: true,
      unitOfWork: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryImageSet, {
      unitOfWork: true,
      categoryImages: true,
      categories: true,
      imageProcessor: true,
      objectStore: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryImageRemove, {
      unitOfWork: true,
      categoryImages: true,
      categories: true,
      imageProcessor: true,
      objectStore: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(CategoryImageRead, {
      unitOfWork: true,
      categoryImages: true,
      objectStore: true,
    }),
    useCaseProvider(CategoryMove, RESTRUCTURE_DEPS),
    useCaseProvider(CategoryMerge, RESTRUCTURE_DEPS),
    useCaseProvider(CategoryArchive, RESTRUCTURE_DEPS),
    useCaseProvider(ReportRetiredCategories, { unitOfWork: true, retirement: true }),
    useCaseProvider(BrandGet, { unitOfWork: true, brandReader: true }),
    useCaseProvider(BrandCreate, {
      unitOfWork: true,
      brands: true,
      clock: true,
      audit: true,
      ids: true,
      contentFilter: true,
    }),
    useCaseProvider(BrandEdit, {
      unitOfWork: true,
      brands: true,
      clock: true,
      audit: true,
      contentFilter: true,
    }),
    useCaseProvider(BrandArchive, { unitOfWork: true, brands: true, clock: true, audit: true }),
    useCaseProvider(BrandApprove, { unitOfWork: true, brands: true, clock: true, audit: true }),
    useCaseProvider(BrandMerge, { unitOfWork: true, brands: true, clock: true, audit: true }),
    useCaseProvider(BrandMergeQueueList, { unitOfWork: true, brandReader: true }),
    useCaseProvider(BrandMergeQueueDismiss, {
      unitOfWork: true,
      brands: true,
      clock: true,
      audit: true,
    }),
    useCaseProvider(OwnBrandPropose, {
      unitOfWork: true,
      brands: true,
      brandReader: true,
      eligibility: true,
      clock: true,
      ids: true,
      audit: true,
      contentFilter: true,
    }),
    useCaseProvider(OwnCategoryPropose, {
      unitOfWork: true,
      contentFilter: true,
      shelves: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      capability: true,
      proposalPolicy: true,
      eligibility: true,
      counters: true,
      counterKeys: true,
    }),
    useCaseProvider(OwnCategoryProposalCancel, {
      unitOfWork: true,
      shelves: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnCategoryProposalsList, {
      unitOfWork: true,
      shelves: true,
      capability: true,
      proposalPolicy: true,
    }),
    useCaseProvider(CategoryProposalList, { unitOfWork: true, shelves: true, sellerNames: true }),
    useCaseProvider(CategoryProposalApprove, {
      unitOfWork: true,
      shelves: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
      capability: true,
      policy: true,
    }),
    useCaseProvider(CategoryProposalReject, {
      unitOfWork: true,
      shelves: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SellerCategoryAdminList, { unitOfWork: true, shelves: true }),
    useCaseProvider(SellerCategoryPromote, {
      unitOfWork: true,
      contentFilter: true,
      store: true,
      categories: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
      shelves: true,
    }),
    useCaseProvider(SellerCategoryMerge, {
      unitOfWork: true,
      shelves: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnOfferSetShelf, { unitOfWork: true, shelves: true, clock: true }),
    useCaseProvider(CancelPendingProposals, {
      unitOfWork: true,
      shelves: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(BrandProductIdsQuery, { unitOfWork: true, brandReader: true }),
    useCaseProvider(PublicBrandQuery, { unitOfWork: true, brandReader: true }),
    useCaseProvider(PublicBrandsAzQuery, { unitOfWork: true, brandReader: true }),
    useCaseProvider(PlatformProductCreate, {
      unitOfWork: true,
      products: true,
      attributes: true,
      policy: true,
      productTypes: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnOfferCreateOnPlatformProduct, {
      unitOfWork: true,
      products: true,
      offers: true,
      eligibility: true,
      allowedTypes: true,
      check: true,
      save: true,
      policy: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnOfferEdit, {
      unitOfWork: true,
      offers: true,
      eligibility: true,
      check: true,
      save: true,
      policy: true,
      claims: true,
      evaluator: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(OwnOfferSetHandling, {
      unitOfWork: true,
      offers: true,
      eligibility: true,
      save: true,
      claims: true,
      evaluator: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(OwnOfferRecordAttestation, {
      unitOfWork: true,
      offers: true,
      eligibility: true,
      save: true,
      claims: true,
      evaluator: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(OwnOfferSubmit, {
      unitOfWork: true,
      offers: true,
      products: true,
      eligibility: true,
      allowedTypes: true,
      check: true,
      policy: true,
      outbox: true,
      claims: true,
      evaluator: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnOfferAddTag, {
      unitOfWork: true,
      offers: true,
      eligibility: true,
      save: true,
      claims: true,
      evaluator: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnOfferRemoveTag, {
      unitOfWork: true,
      offers: true,
      eligibility: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(OwnOfferRemoveSuspendedTag, {
      unitOfWork: true,
      offers: true,
      eligibility: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(OwnOfferSetSellUnits, {
      unitOfWork: true,
      offers: true,
      sellUnits: true,
      eligibility: true,
      save: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(OwnOfferDelete, {
      unitOfWork: true,
      offers: true,
      products: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(OfferApprove, {
      unitOfWork: true,
      offers: true,
      products: true,
      eligibility: true,
      allowedTypes: true,
      check: true,
      outbox: true,
      clock: true,
      claims: true,
      evaluator: true,
    }),
    useCaseProvider(OfferRequestChanges, {
      unitOfWork: true,
      offers: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(ReviewQueueList, {
      unitOfWork: true,
      offers: true,
      ownReader: true,
      policy: true,
      sellerNames: true,
      gtinRegistry: true,
    }),
    useCaseProvider(AdminCustomVariantLabels, {
      unitOfWork: true,
      customVariantLabelsReader: true,
      policy: true,
    }),
    // Variants V6: the admin Catalogue > Variants page.
    useCaseProvider(AdminVariantTypesList, {
      unitOfWork: true,
      variantAdminReader: true,
      policy: true,
    }),
    useCaseProvider(AdminVariantTypeGet, {
      unitOfWork: true,
      variantAdminReader: true,
      policy: true,
    }),
    useCaseProvider(VariantTypeSettingsEdit, {
      unitOfWork: true,
      variantAdminReader: true,
      variantTypeSettings: true,
      policy: true,
      matcher: true,
      claimLocales: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AdminVariantsList, {
      unitOfWork: true,
      variantAdminReader: true,
      policy: true,
    }),
    useCaseProvider(AdminVariantIssueCounts, {
      unitOfWork: true,
      variantAdminReader: true,
      policy: true,
    }),
    useCaseProvider(AdminVariantsExport, {
      unitOfWork: true,
      variantAdminReader: true,
      adminVariantsReader: true,
      policy: true,
      sheetWriter: true,
      clock: true,
    }),
    useCaseProvider(AttributeFilesExport, {
      unitOfWork: true,
      attributeAdminReader: true,
      policy: true,
      sheetWriter: true,
      clock: true,
    }),
    useCaseProvider(AttributeImportCheck, {
      unitOfWork: true,
      attributeAdminReader: true,
      policy: true,
      importParsers: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    useCaseProvider(AttributeImportRun, {
      unitOfWork: true,
      attributeAdminReader: true,
      policy: true,
      importParsers: true,
      counters: true,
      counterKeys: true,
      attributeCreate: true,
      attributeEdit: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(AdminProductsList, {
      unitOfWork: true,
      adminProductsReader: true,
      policy: true,
      sellerNames: true,
    }),
    useCaseProvider(PlatformImportCheck, {
      unitOfWork: true,
      treeReader: true,
      attributes: true,
      familyResolver: true,
      policy: true,
      productTypes: true,
      importJobs: true,
      importFiles: true,
      importParsers: true,
      counters: true,
      counterKeys: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(PlatformImportStart, {
      unitOfWork: true,
      importJobs: true,
      authorisation: true,
      counters: true,
      counterKeys: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(PlatformImportRead, { unitOfWork: true, importJobs: true }),
    useCaseProvider(PlatformImportReport, { unitOfWork: true, importJobs: true, clock: true }),
    useCaseProvider(PlatformImportTemplate, {
      unitOfWork: true,
      attributeAdminReader: true,
      policy: true,
      sheetWriter: true,
    }),
    useCaseProvider(PlatformImportDiscard, {
      unitOfWork: true,
      importJobs: true,
      importFiles: true,
      clock: true,
    }),
    useCaseProvider(PlatformImportResume, { unitOfWork: true, importJobs: true, clock: true }),
    useCaseProvider(PlatformImportRun, {
      unitOfWork: true,
      treeReader: true,
      attributes: true,
      familyResolver: true,
      policy: true,
      productTypes: true,
      importJobs: true,
      importFiles: true,
      importParsers: true,
      products: true,
      outbox: true,
      clock: true,
      jobContexts: true,
      platformCreate: true,
      rowSave: true,
      rowSubmit: true,
    }),
    useCaseProvider(PlatformImportRowSave, { saveDraft: true }),
    useCaseProvider(PlatformImportRowSubmit, { submit: true, authorisation: true }),
    useCaseProvider(PlatformImportPurge, {
      unitOfWork: true,
      importJobs: true,
      importFiles: true,
      clock: true,
    }),
    // The seller import (catalog design 14c).
    portVariantProvider(
      OWN_IMPORT_PRODUCT_CREATE,
      OwnProductCreate,
      {
        unitOfWork: true,
        products: true,
        offers: true,
        check: true,
        attributes: true,
        eligibility: true,
        allowedTypes: true,
        save: true,
        policy: true,
        productTypes: true,
        outbox: true,
        clock: true,
        ids: true,
      },
      { save: NO_SAVE_BUDGET },
    ),
    portVariantProvider(
      OWN_IMPORT_OFFER_CREATE,
      OwnOfferCreateOnPlatformProduct,
      {
        unitOfWork: true,
        products: true,
        offers: true,
        eligibility: true,
        allowedTypes: true,
        check: true,
        save: true,
        policy: true,
        outbox: true,
        clock: true,
        ids: true,
      },
      { save: NO_SAVE_BUDGET },
    ),
    portVariantProvider(
      OWN_IMPORT_OFFER_EDIT,
      OwnOfferEdit,
      {
        unitOfWork: true,
        offers: true,
        eligibility: true,
        check: true,
        save: true,
        policy: true,
        claims: true,
        evaluator: true,
        outbox: true,
        clock: true,
      },
      { save: NO_SAVE_BUDGET },
      ['import-row'],
    ),
    portVariantProvider(
      OWN_IMPORT_IMAGE_UPLOAD,
      OwnProductImageUpload,
      {
        unitOfWork: true,
        products: true,
        images: true,
        imageProcessor: true,
        objectStore: true,
        eligibility: true,
        save: true,
        clock: true,
        ids: true,
      },
      { save: NO_SAVE_BUDGET },
    ),
    {
      provide: OwnImportRowCreate,
      inject: [USE_CASE_GATE, OWN_IMPORT_PRODUCT_CREATE],
      useFactory: (gate: UseCaseGate, create: OwnProductCreate) =>
        new OwnImportRowCreate(gate, { create }),
    },
    {
      provide: OwnImportRowOfferCreate,
      inject: [USE_CASE_GATE, OWN_IMPORT_OFFER_CREATE],
      useFactory: (gate: UseCaseGate, create: OwnOfferCreateOnPlatformProduct) =>
        new OwnImportRowOfferCreate(gate, { create }),
    },
    {
      provide: OwnImportRowOfferEdit,
      inject: [USE_CASE_GATE, OWN_IMPORT_OFFER_EDIT],
      useFactory: (gate: UseCaseGate, edit: OwnOfferEdit) =>
        new OwnImportRowOfferEdit(gate, { edit }),
    },
    useCaseProvider(OwnImportRowSave, {
      unitOfWork: true,
      products: true,
      workingCopies: true,
      revisions: true,
      saveDraft: true,
      eligibility: true,
      allowedTypes: true,
      policy: true,
    }),
    useCaseProvider(OwnImportCheck, {
      unitOfWork: true,
      treeReader: true,
      attributes: true,
      policy: true,
      productTypes: true,
      sellerJobs: true,
      importFiles: true,
      importParsers: true,
      counters: true,
      counterKeys: true,
      importFacts: true,
      eligibility: true,
      allowedTypes: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnImportStart, {
      unitOfWork: true,
      sellerJobs: true,
      eligibility: true,
      counters: true,
      counterKeys: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(OwnImportRead, { unitOfWork: true, sellerJobs: true, clock: true }),
    useCaseProvider(OwnImportReport, { unitOfWork: true, sellerJobs: true, clock: true }),
    useCaseProvider(OwnImportTemplate, { policy: true, sheetWriter: true }),
    useCaseProvider(OwnImportDiscard, {
      unitOfWork: true,
      sellerJobs: true,
      importFiles: true,
      clock: true,
    }),
    useCaseProvider(OwnImportResume, {
      unitOfWork: true,
      sellerJobs: true,
      eligibility: true,
      clock: true,
    }),
    useCaseProvider(OwnImportAddPhoto, {
      unitOfWork: true,
      sellerJobs: true,
      products: true,
      workingCopies: true,
      revisions: true,
      saveDraft: true,
      ownImageUpload: true,
      ownImageDelete: true,
      eligibility: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    useCaseProvider(OwnImportRun, {
      unitOfWork: true,
      treeReader: true,
      attributes: true,
      policy: true,
      productTypes: true,
      sellerJobs: true,
      importFiles: true,
      importParsers: true,
      importFacts: true,
      eligibilityStatus: true,
      allowedTypes: true,
      offers: true,
      outbox: true,
      clock: true,
      jobContexts: true,
      ownRowCreate: true,
      ownRowSave: true,
      ownRowOfferCreate: true,
      ownRowOfferEdit: true,
    }),
    useCaseProvider(OwnImportPurge, {
      unitOfWork: true,
      sellerJobs: true,
      importFiles: true,
      clock: true,
    }),
    {
      provide: SavedFilterShareCheck,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate): SavedFilterShareCheck => new SavedFilterShareCheck(gate),
    },
    useCaseProvider(SavedFiltersList, {
      unitOfWork: true,
      savedFilters: true,
      shareCheck: true,
      adminProductsReader: true,
      policy: true,
    }),
    useCaseProvider(SavedFilterCreate, {
      unitOfWork: true,
      savedFilters: true,
      shareCheck: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SavedFilterUpdate, {
      unitOfWork: true,
      savedFilters: true,
      shareCheck: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SavedFilterDelete, {
      unitOfWork: true,
      savedFilters: true,
      shareCheck: true,
      audit: true,
    }),
    {
      provide: OwnSavedFilterShareCheck,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate): OwnSavedFilterShareCheck =>
        new OwnSavedFilterShareCheck(gate),
    },
    useCaseProvider(OwnSavedFiltersList, {
      unitOfWork: true,
      sellerSavedFilters: true,
      ownShareCheck: true,
    }),
    useCaseProvider(OwnSavedFilterCreate, {
      unitOfWork: true,
      sellerSavedFilters: true,
      ownShareCheck: true,
      audit: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnSavedFilterUpdate, {
      unitOfWork: true,
      sellerSavedFilters: true,
      ownShareCheck: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(OwnSavedFilterDelete, {
      unitOfWork: true,
      sellerSavedFilters: true,
      ownShareCheck: true,
      audit: true,
    }),
    useCaseProvider(AdminProductPause, {
      unitOfWork: true,
      products: true,
      offers: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(AdminProductResume, {
      unitOfWork: true,
      products: true,
      offers: true,
      outbox: true,
      audit: true,
      clock: true,
      claims: true,
      evaluator: true,
    }),
    useCaseProvider(AdminProductWithdraw, {
      unitOfWork: true,
      products: true,
      offers: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(PlatformProductRetire, {
      unitOfWork: true,
      products: true,
      offers: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(AdminProductsBulk, {
      unitOfWork: true,
      adminProductsReader: true,
      policy: true,
      pause: true,
      resume: true,
      withdraw: true,
      retire: true,
    }),
    useCaseProvider(AdminProductsExport, {
      unitOfWork: true,
      adminProductsReader: true,
      policy: true,
      sellerNames: true,
      sheetWriter: true,
      clock: true,
    }),
    useCaseProvider(ProductRevisionApprove, {
      unitOfWork: true,
      products: true,
      revisions: true,
      eligibility: true,
      check: true,
      policy: true,
      outbox: true,
      clock: true,
      offerFinder: true,
      offers: true,
      claims: true,
      evaluator: true,
      brandAssigner: true,
    }),
    useCaseProvider(ProductRevisionRequestChanges, {
      unitOfWork: true,
      products: true,
      revisions: true,
      attributes: true,
      policy: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(ProductRevisionAdminRead, {
      unitOfWork: true,
      products: true,
      revisions: true,
      sellerNames: true,
      gtinRegistry: true,
      topicReader: true,
      policy: true,
    }),
    useCaseProvider(OwnProductCreate, {
      unitOfWork: true,
      products: true,
      offers: true,
      check: true,
      attributes: true,
      eligibility: true,
      allowedTypes: true,
      save: true,
      policy: true,
      productTypes: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnProductSaveDraft, { saveDraft: true, eligibility: true }),
    useCaseProvider(OwnProductSetOwnBrand, {
      unitOfWork: true,
      products: true,
      eligibility: true,
      clock: true,
    }),
    useCaseProvider(OwnProductSubmit, {
      unitOfWork: true,
      products: true,
      submit: true,
      eligibility: true,
      allowedTypes: true,
      offerFinder: true,
      offers: true,
      claims: true,
      evaluator: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnProductOptions, { policy: true, allowedTypes: true }),
    useCaseProvider(OwnProductImageUpload, {
      unitOfWork: true,
      products: true,
      images: true,
      imageProcessor: true,
      objectStore: true,
      eligibility: true,
      save: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(OwnProductImageList, { unitOfWork: true, products: true, images: true }),
    useCaseProvider(OwnProductImageRead, {
      unitOfWork: true,
      products: true,
      images: true,
      objectStore: true,
    }),
    useCaseProvider(OwnProductImageDelete, {
      unitOfWork: true,
      products: true,
      images: true,
      objectStore: true,
    }),
    useCaseProvider(ProductRevisionImageList, {
      unitOfWork: true,
      revisions: true,
      images: true,
    }),
    useCaseProvider(ProductImageAdminRead, { unitOfWork: true, images: true, objectStore: true }),
    useCaseProvider(PlatformProductImageUpload, {
      unitOfWork: true,
      products: true,
      images: true,
      imageProcessor: true,
      objectStore: true,
      save: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(PlatformProductImageList, { unitOfWork: true, products: true, images: true }),
    useCaseProvider(PlatformProductImageDelete, {
      unitOfWork: true,
      products: true,
      images: true,
      objectStore: true,
      audit: true,
    }),
    useCaseProvider(ProductImageTakeDown, {
      unitOfWork: true,
      images: true,
      objectStore: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(SweepOrphanImages, {
      unitOfWork: true,
      images: true,
      workingCopies: true,
      objectStore: true,
      clock: true,
    }),
    useCaseProvider(ReprocessImageFormats, {
      unitOfWork: true,
      images: true,
      objectStore: true,
    }),
    useCaseProvider(SweepOrphanImageFiles, {
      unitOfWork: true,
      images: true,
      objectStore: true,
      clock: true,
    }),
    useCaseProvider(OwnProductsList, { unitOfWork: true, ownReader: true, policy: true }),
    useCaseProvider(OwnProductsExport, {
      unitOfWork: true,
      ownReader: true,
      policy: true,
      sheetWriter: true,
      clock: true,
    }),
    useCaseProvider(OwnProductRead, {
      unitOfWork: true,
      products: true,
      workingCopies: true,
      revisions: true,
      ownReader: true,
      policy: true,
      suggestions: true,
      attributeStore: true,
      familyResolver: true,
      topicReader: true,
    }),
    useCaseProvider(OwnOffersList, { unitOfWork: true, ownReader: true, policy: true }),
    useCaseProvider(OwnOfferRead, {
      unitOfWork: true,
      offers: true,
      ownReader: true,
      policy: true,
    }),
    useCaseProvider(OwnOfferReadSellUnits, {
      unitOfWork: true,
      offers: true,
      reader: true,
      labelsReader: true,
      productSellUnitFacts: true,
      policy: true,
    }),
    useCaseProvider(PlatformProductSaveDraft, { saveDraft: true }),
    useCaseProvider(PlatformProductSubmit, { submit: true }),
    useCaseProvider(PlatformProductDiscard, {
      unitOfWork: true,
      products: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(PlatformProductOptions, { policy: true }),
    useCaseProvider(PlatformProductRead, {
      unitOfWork: true,
      products: true,
      workingCopies: true,
      revisions: true,
      ownReader: true,
      topicReader: true,
      policy: true,
      familyResolver: true,
    }),
    serviceProvider(AddSizes, {
      unitOfWork: true,
      products: true,
      workingCopies: true,
      revisions: true,
      offers: true,
      offerFinder: true,
      attributes: true,
      familyResolver: true,
      policy: true,
      allowedTypes: true,
      counters: true,
      counterKeys: true,
      outbox: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(OwnProductAddSizes, { addSizes: true, eligibility: true }),
    useCaseProvider(PlatformProductAddSizes, { addSizes: true }),
    useCaseProvider(PlatformProductAddSizesImpact, { addSizes: true }),
    useCaseProvider(SeedCategoryTree, {
      unitOfWork: true,
      categories: true,
      seed: true,
      check: true,
      policy: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(SeedAttributes, {
      unitOfWork: true,
      attributes: true,
      attributeSeed: true,
      check: true,
      policy: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(ReevaluateTags, {
      unitOfWork: true,
      requests: true,
      offers: true,
      claims: true,
      evaluator: true,
      outbox: true,
      clock: true,
      tagSelection: true,
    }),
    useCaseProvider(ReconcileTags, {
      unitOfWork: true,
      offers: true,
      claims: true,
      evaluator: true,
      outbox: true,
      clock: true,
      tagSelection: true,
    }),
    useCaseProvider(ReevaluateFromCertification, {
      unitOfWork: true,
      requests: true,
      ids: true,
      clock: true,
    }),
    registerJobsFrom(
      'catalog',
      [
        SeedCategoryTree,
        SeedAttributes,
        SeedCultures,
        SweepOrphanImages,
        SweepOrphanImageFiles,
        ReevaluateTags,
        ReconcileTags,
        SendOfferOwnerNotices,
        PlatformImportRun,
        PlatformImportPurge,
        OwnImportRun,
        OwnImportPurge,
        ExpireRelaxationRequests,
        SendAttributeSuggestionNotices,
        SendMissingDetailsEmails,
        SendTopicSuggestionNotices,
      ],
      (
        categories: SeedCategoryTree,
        attributes: SeedAttributes,
        cultures: SeedCultures,
        sweep: SweepOrphanImages,
        sweepFiles: SweepOrphanImageFiles,
        reevaluate: ReevaluateTags,
        reconcile: ReconcileTags,
        notices: SendOfferOwnerNotices,
        importRun: PlatformImportRun,
        importPurge: PlatformImportPurge,
        sellerRun: OwnImportRun,
        sellerPurge: OwnImportPurge,
        expireRelaxations: ExpireRelaxationRequests,
        suggestionNotices: SendAttributeSuggestionNotices,
        missingDetailsEmails: SendMissingDetailsEmails,
        topicSuggestionNotices: SendTopicSuggestionNotices,
      ) => [
        seedCategoryTreeJob(categories),
        seedAttributesJob(attributes),
        seedCulturesJob(cultures),
        sweepOrphanImagesJob(sweep),
        sweepOrphanImageFilesJob(sweepFiles),
        reevaluateTagsJob(reevaluate),
        reconcileTagsJob(reconcile),
        sendOfferOwnerNoticesJob(notices),
        platformImportRunJob(importRun),
        purgePlatformImportsJob(importPurge),
        ownImportRunJob(sellerRun),
        purgeSellerImportsJob(sellerPurge),
        expireRelaxationRequestsJob(expireRelaxations),
        sendAttributeSuggestionNoticesJob(suggestionNotices),
        sendMissingDetailsEmailsJob(missingDetailsEmails),
        sendTopicSuggestionNoticesJob(topicSuggestionNotices),
      ],
    ),
    // Seller category proposals: SEL-26 switched off cancels the pending ones (categories C9a).
    registerSubscriptionsFrom(
      'catalog',
      [CancelPendingProposals],
      (cancel: CancelPendingProposals) => sellerCategoryProposalSubscriptions(cancel),
    ),
    // Certification events consumed (design 5.5, 9.5; slice 12).
    registerSubscriptionsFrom(
      'catalog',
      [ReevaluateFromCertification, WarnOfferOwnersOfExpiry, ReportRetiredCategories],
      (
        reevaluate: ReevaluateFromCertification,
        warn: WarnOfferOwnersOfExpiry,
        report: ReportRetiredCategories,
      ) => [
        ...certificationSubscriptions(reevaluate),
        ...certificateExpiryNoticeSubscriptions(warn),
        ...categoryRetirementSubscriptions(report),
      ],
    ),
    // Certification request C-6 (slice 15): the Owners of Offers whose badge rests on an
    // expiring manufacturer certificate are warned through identity's contact point.
    {
      provide: OFFER_OWNER_CONTACT,
      inject: [IDENTITY_FACADE],
      useFactory: (identity: IdentityFacade): OfferOwnerContact =>
        new IdentityOfferOwnerContact(identity),
    },
    {
      provide: OFFER_OWNER_MAIL_SETTINGS,
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry): OfferOwnerMailSettings =>
        new ConfigOfferOwnerMailSettings(markets),
    },
    {
      provide: MISSING_DETAILS_MAIL_SETTINGS,
      inject: [MarketRegistry],
      useFactory: (markets: MarketRegistry): MissingDetailsMailSettings =>
        new ConfigMissingDetailsMailSettings(markets),
    },
    // "Email sellers" of the Missing details report (attributes package A4-4): the admin request
    // writes one row per seller and product; the job sends one mail per seller.
    useCaseProvider(MissingDetailsEmailSellers, {
      unitOfWork: true,
      detailsGapReader: true,
      attributes: true,
      attributeAdminReader: true,
      familyResolver: true,
      policy: true,
      sellerNames: true,
      emailStore: true,
      missingDetailsMailSettings: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(SendMissingDetailsEmails, {
      unitOfWork: true,
      emailStore: true,
      ownerContacts: true,
      mailTransport: true,
      missingDetailsMailSettings: true,
      clock: true,
    }),
    // Hassan M1, Mojtaba N2: the handler writes one notice per Owner; the job sends each.
    useCaseProvider(WarnOfferOwnersOfExpiry, {
      unitOfWork: true,
      tagSelection: true,
      notices: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(SendOfferOwnerNotices, {
      unitOfWork: true,
      notices: true,
      ownerContacts: true,
      mailTransport: true,
      mailSettings: true,
      clock: true,
    }),
    useCaseProvider(OfferSellUnitsQuery, { unitOfWork: true, reader: true }),
    useCaseProvider(OfferSellUnitsSystemQuery, { unitOfWork: true, reader: true }),
    useCaseProvider(OfferNamesSystemQuery, { unitOfWork: true, namesReader: true }),
    useCaseProvider(SellUnitLabelsQuery, { unitOfWork: true, labelsReader: true }),
    useCaseProvider(OfferTaxCategoriesQuery, { unitOfWork: true, taxCategoriesReader: true }),
    useCaseProvider(PendingProductRevisionsQuery, {
      unitOfWork: true,
      pendingRevisionsReader: true,
    }),
    useCaseProvider(SellerProductOwnersQuery, {
      unitOfWork: true,
      productOwnersReader: true,
    }),
    useCaseProvider(ProductsForLinkingQuery, {
      unitOfWork: true,
      productLinkingReader: true,
    }),
    useCaseProvider(CategoryTreeQuery, { unitOfWork: true, treeReader: true, policy: true }),
    useCaseProvider(PublicCategoryTreeQuery, {
      unitOfWork: true,
      treeReader: true,
      publicCategories: true,
      policy: true,
    }),
    useCaseProvider(CategorySlugResolveQuery, {
      unitOfWork: true,
      treeReader: true,
      publicCategories: true,
      policy: true,
    }),
    useCaseProvider(OfferListingsQuery, {
      unitOfWork: true,
      listingsReader: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(OfferListingsSystemQuery, {
      unitOfWork: true,
      listingsReader: true,
      policy: true,
      clock: true,
    }),
    useCaseProvider(OfferBadgesQuery, {
      unitOfWork: true,
      offers: true,
      claims: true,
      evaluator: true,
      policy: true,
    }),
    useCaseProvider(PublishedProductQuery, {
      unitOfWork: true,
      publishedProductReader: true,
      policy: true,
    }),
    useCaseProvider(PublishedProductImagesQuery, {
      unitOfWork: true,
      publishedImagesReader: true,
    }),
    useCaseProvider(PublishedImageRead, {
      unitOfWork: true,
      publishedImagesReader: true,
      objectStore: true,
    }),
    {
      provide: CATALOG_FACADE,
      inject: [
        OfferSellUnitsQuery,
        OfferSellUnitsSystemQuery,
        OfferNamesSystemQuery,
        SellUnitLabelsQuery,
        OfferTaxCategoriesQuery,
        OfferListingsQuery,
        OfferListingsSystemQuery,
        OfferBadgesQuery,
        PublishedProductQuery,
        BrandProductIdsQuery,
        PublishedProductImagesQuery,
        PendingProductRevisionsQuery,
        SellerProductOwnersQuery,
        ProductsForLinkingQuery,
      ],
      useFactory: (
        offerSellUnits: OfferSellUnitsQuery,
        offerSellUnitsSystem: OfferSellUnitsSystemQuery,
        offerNamesSystem: OfferNamesSystemQuery,
        sellUnitLabels: SellUnitLabelsQuery,
        offerTaxCategories: OfferTaxCategoriesQuery,
        offerListings: OfferListingsQuery,
        offerListingsSystem: OfferListingsSystemQuery,
        offerBadges: OfferBadgesQuery,
        publishedProduct: PublishedProductQuery,
        brandProductIds: BrandProductIdsQuery,
        publishedProductImages: PublishedProductImagesQuery,
        pendingProductRevisions: PendingProductRevisionsQuery,
        sellerProductOwners: SellerProductOwnersQuery,
        productsForLinking: ProductsForLinkingQuery,
      ) =>
        new CatalogFacadeImplementation({
          offerSellUnits,
          offerSellUnitsSystem,
          offerNamesSystem,
          sellUnitLabels,
          offerTaxCategories,
          offerListings,
          offerListingsSystem,
          offerBadges,
          publishedProduct,
          brandProductIds,
          publishedProductImages,
          pendingProductRevisions,
          sellerProductOwners,
          productsForLinking,
        }),
    },
    useCaseProvider(OfferSearchFactsQuery, { unitOfWork: true, searchReader: true }),
    useCaseProvider(PublishedOfferIdsQuery, { unitOfWork: true, searchReader: true }),
    useCaseProvider(SearchIndexStampQuery, { unitOfWork: true, searchReader: true }),
    {
      provide: CATALOG_INDEX_FACADE,
      inject: [OfferSearchFactsQuery, PublishedOfferIdsQuery, SearchIndexStampQuery],
      useFactory: (
        facts: OfferSearchFactsQuery,
        published: PublishedOfferIdsQuery,
        stamp: SearchIndexStampQuery,
      ) => new CatalogIndexFacadeImplementation(facts, published, stamp),
    },
    useCaseProvider(SearchFiltersQuery, {
      unitOfWork: true,
      treeReader: true,
      linkStore: true,
      filterReader: true,
    }),
    {
      provide: CATALOG_FILTERS_FACADE,
      inject: [SearchFiltersQuery],
      useFactory: (query: SearchFiltersQuery) => new CatalogFiltersFacadeImplementation(query),
    },
    {
      provide: CATALOG_ASSISTANT_FACADE,
      inject: [CategoryTreeQuery],
      useFactory: (tree: CategoryTreeQuery) => new CatalogAssistantFacadeImplementation(tree),
    },
  ],
  exports: [
    CATALOG_FACADE,
    CATALOG_INDEX_FACADE,
    CATALOG_ASSISTANT_FACADE,
    CATALOG_FILTERS_FACADE,
    CATALOG_ACTIVITIES_FACADE,
    CATALOG_CULTURES_FACADE,
  ],
})
export class CatalogModule {}
