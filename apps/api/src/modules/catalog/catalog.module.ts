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
import { PRODUCT_REVISION_REPOSITORY } from './application/ports/product-revision.repository';
import {
  PRODUCT_TYPE_LOOKUP,
  type ProductTypeLookup,
} from './application/ports/product-type-lookup';
import { ALLOWED_PRODUCT_TYPES_READER } from './application/ports/allowed-product-types.reader';
import { OFFER_REPOSITORY } from './application/ports/offer.repository';
import { OWN_OFFER_FINDER } from './application/ports/own-offer-finder';
import { CLAIM_EVALUATOR } from './application/ports/claim-evaluator';
import { CATEGORY_PATHS_READER } from './application/ports/category-paths.reader';
import { ClaimQueryBuilder } from './application/tags/claim-query-builder';
import { OwnOfferAddTag } from './application/use-cases/own-offer-add-tag.use-case';
import { OwnOfferRemoveTag } from './application/use-cases/own-offer-remove-tag.use-case';
import { SELLER_ELIGIBILITY_READER } from './application/ports/seller-eligibility.reader';
import { SELLER_NAMES_READER } from './application/ports/seller-names.reader';
import { ProductRevisionApprove } from './application/use-cases/product-revision-approve.use-case';
import { ProductRevisionRequestChanges } from './application/use-cases/product-revision-request-changes.use-case';
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
import { AdminProductsList } from './application/use-cases/admin-products-list.use-case';
import { ADMIN_PRODUCTS_READER } from './application/ports/admin-products.reader';
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
import { PlatformImportRun } from './application/use-cases/platform-import-run.use-case';
import { PlatformImportController } from './presentation/platform-import.controller';
import { platformImportRunJob } from './presentation/jobs/platform-import-run.job';
import { purgePlatformImportsJob } from './presentation/jobs/purge-platform-imports.job';
import { AdminProductResume } from './application/use-cases/admin-product-resume.use-case';
import { AdminProductWithdraw } from './application/use-cases/admin-product-withdraw.use-case';
import { PlatformProductRetire } from './application/use-cases/platform-product-retire.use-case';
import { AdminProductsBulk } from './application/use-cases/admin-products-bulk.use-case';
import { AdminProductsExport } from './application/use-cases/admin-products-export.use-case';
import { SAVED_FILTER_REPOSITORY } from './application/ports/saved-filter.repository';
import { SavedFilterCreate } from './application/use-cases/saved-filter-create.use-case';
import { SavedFilterDelete } from './application/use-cases/saved-filter-delete.use-case';
import { SavedFilterShareCheck } from './application/use-cases/saved-filter-share-check.use-case';
import { SavedFilterUpdate } from './application/use-cases/saved-filter-update.use-case';
import { SavedFiltersList } from './application/use-cases/saved-filters-list.use-case';
import { SavedFilterController } from './presentation/saved-filter.controller';
import { CATALOG_AUDIT_ACTIONS } from './domain/audit';
import { OFFER_SEARCH_FACTS_READER } from './application/ports/offer-search-facts.reader';
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
import { SubmitProduct } from './application/revisions/submit-product.service';
import { SaveDraft } from './application/working-copy/save-draft.service';
import { SaveWorkingCopy } from './application/working-copy/save-working-copy.service';
import { PlatformProductCreate } from './application/use-cases/platform-product-create.use-case';
import { PlatformProductSaveDraft } from './application/use-cases/platform-product-save-draft.use-case';
import { PlatformProductSubmit } from './application/use-cases/platform-product-submit.use-case';
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
import { OwnProductsList } from './application/use-cases/own-products-list.use-case';
import { OwnProductRead } from './application/use-cases/own-product-read.use-case';
import { OwnOffersList } from './application/use-cases/own-offers-list.use-case';
import { OwnOfferRead } from './application/use-cases/own-offer-read.use-case';
import { OWN_CATALOG_READER } from './application/ports/own-catalog.reader';
import {
  PRODUCT_IMAGE_REPOSITORY,
  type ProductImageRepository,
} from './application/ports/product-image.repository';
import { IMAGE_PROCESSOR } from './application/ports/image-processor';
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
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OwnProductImageUpload } from './application/use-cases/own-product-image-upload.use-case';
import { OwnProductImageList } from './application/use-cases/own-product-image-list.use-case';
import { OwnProductImageRead } from './application/use-cases/own-product-image-read.use-case';
import { OwnProductImageDelete } from './application/use-cases/own-product-image-delete.use-case';
import { ProductImageController } from './presentation/product-image.controller';
import { ProductImageReviewController } from './presentation/product-image-review.controller';
import { ProductImageAdminRead } from './application/use-cases/product-image-admin-read.use-case';
import { ProductImageTakeDown } from './application/use-cases/product-image-take-down.use-case';
import { ProductRevisionImageList } from './application/use-cases/product-revision-image-list.use-case';
import { SweepOrphanImages } from './application/use-cases/sweep-orphan-images.use-case';
import { sweepOrphanImagesJob } from './presentation/jobs/sweep-orphan-images.job';
import { ReevaluateTags } from './application/use-cases/reevaluate-tags.use-case';
import { OfferBadgesQuery } from './application/use-cases/offer-badges.use-case';
import { OfferListingsQuery } from './application/use-cases/offer-listings.use-case';
import { OfferListingsSystemQuery } from './application/use-cases/offer-listings-system.use-case';
import { OFFER_LISTINGS_READER } from './application/ports/offer-listings.reader';
import { PublishedProductQuery } from './application/use-cases/published-product.use-case';
import { PUBLISHED_PRODUCT_READER } from './application/ports/published-product.reader';
import { PUBLISHED_IMAGES_READER } from './application/ports/published-images.reader';
import { PublishedProductImagesQuery } from './application/use-cases/published-product-images.use-case';
import { PublishedImageRead } from './application/use-cases/published-image-read.use-case';
import { PublicProductImageController } from './presentation/public-product-image.controller';
import { reevaluateTagsJob } from './presentation/jobs/reevaluate-tags.job';
import { OwnProductController } from './presentation/own-product.controller';
import { OwnProductCreate } from './application/use-cases/own-product-create.use-case';
import { OwnProductOptions } from './application/use-cases/own-product-options.use-case';
import { OwnProductSaveDraft } from './application/use-cases/own-product-save-draft.use-case';
import { OwnProductSubmit } from './application/use-cases/own-product-submit.use-case';
import { catalogProviders } from './infrastructure/catalog-providers';
import { assertCatalogConfigured } from './infrastructure/market-config-boot-check';
import { seedAttributesJob } from './presentation/jobs/seed-attributes.job';
import { CatalogFacadeImplementation } from './presentation/catalog.facade';
import { CatalogIndexFacadeImplementation } from './presentation/catalog-index.facade';
import { seedCategoryTreeJob } from './presentation/jobs/seed-category-tree.job';

/**
 * The Nest token of each dependency name the use cases of catalog share: a use case's dependency
 * object is built from these by {@link useCaseProvider}, so a name always means the same port.
 */
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
  reader: OFFER_SELL_UNITS_READER,
  searchReader: OFFER_SEARCH_FACTS_READER,
  namesReader: OFFER_NAMES_READER,
  labelsReader: SELL_UNIT_LABELS_READER,
  taxCategoriesReader: OFFER_TAX_CATEGORIES_READER,
  pendingRevisionsReader: PENDING_PRODUCT_REVISIONS_READER,
  productOwnersReader: SELLER_PRODUCT_OWNERS_READER,
  productLinkingReader: PRODUCT_LINKING_READER,
  treeReader: CATEGORY_TREE_READER,
  offers: OFFER_REPOSITORY,
  offerFinder: OWN_OFFER_FINDER,
  claims: ClaimQueryBuilder,
  evaluator: CLAIM_EVALUATOR,
  categoryPaths: CATEGORY_PATHS_READER,
  eligibility: SELLER_ELIGIBILITY_READER,
  allowedTypes: ALLOWED_PRODUCT_TYPES_READER,
  sellerNames: SELLER_NAMES_READER,
  ownReader: OWN_CATALOG_READER,
  adminProductsReader: ADMIN_PRODUCTS_READER,
  images: PRODUCT_IMAGE_REPOSITORY,
  imageProcessor: IMAGE_PROCESSOR,
  objectStore: OBJECT_STORE,
  requests: TAG_REEVALUATION_REQUESTS,
  tagSelection: TAG_SELECTION_READER,
  listingsReader: OFFER_LISTINGS_READER,
  publishedProductReader: PUBLISHED_PRODUCT_READER,
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
  importFiles: IMPORT_FILE_STORE,
  authorisation: AUTHORISATION_CHECK,
  jobContexts: JOB_CALL_CONTEXTS,
  platformCreate: PlatformProductCreate,
  platformSaveDraft: PlatformProductSaveDraft,
  platformSubmit: PlatformProductSubmit,
  savedFilters: SAVED_FILTER_REPOSITORY,
  shareCheck: SavedFilterShareCheck,
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
@Module({
  controllers: [
    PlatformProductController,
    OwnOfferController,
    OwnProductController,
    ProductImageController,
    OfferReviewController,
    AdminProductListController,
    AdminProductBulkController,
    PlatformImportController,
    SavedFilterController,
    ProductReviewController,
    ProductImageReviewController,
    PublicCategoryController,
    PublicProductImageController,
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
      ],
      useFactory: (
        attributes: AttributeRepository,
        policy: CatalogMarketPolicy,
        handlerFor: ProductTypeLookup,
        images: ProductImageRepository,
      ): FreezeRevision => new FreezeRevision({ attributes, policy, handlerFor, images }),
    },
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
    }),
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
      policy: true,
      productTypes: true,
      importJobs: true,
      importFiles: true,
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
    useCaseProvider(PlatformImportTemplate, { policy: true }),
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
      policy: true,
      productTypes: true,
      importJobs: true,
      importFiles: true,
      products: true,
      outbox: true,
      clock: true,
      jobContexts: true,
      platformCreate: true,
      platformSaveDraft: true,
      platformSubmit: true,
      pause: true,
    }),
    useCaseProvider(PlatformImportPurge, {
      unitOfWork: true,
      importJobs: true,
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
    }),
    useCaseProvider(ProductRevisionRequestChanges, {
      unitOfWork: true,
      products: true,
      revisions: true,
      outbox: true,
      clock: true,
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
    useCaseProvider(OwnProductsList, { unitOfWork: true, ownReader: true, policy: true }),
    useCaseProvider(OwnProductRead, {
      unitOfWork: true,
      products: true,
      workingCopies: true,
      revisions: true,
      ownReader: true,
      policy: true,
    }),
    useCaseProvider(OwnOffersList, { unitOfWork: true, ownReader: true, policy: true }),
    useCaseProvider(OwnOfferRead, {
      unitOfWork: true,
      offers: true,
      ownReader: true,
      policy: true,
    }),
    useCaseProvider(PlatformProductSaveDraft, { saveDraft: true }),
    useCaseProvider(PlatformProductSubmit, { submit: true }),
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
        SweepOrphanImages,
        ReevaluateTags,
        ReconcileTags,
        SendOfferOwnerNotices,
        PlatformImportRun,
        PlatformImportPurge,
      ],
      (
        categories: SeedCategoryTree,
        attributes: SeedAttributes,
        sweep: SweepOrphanImages,
        reevaluate: ReevaluateTags,
        reconcile: ReconcileTags,
        notices: SendOfferOwnerNotices,
        importRun: PlatformImportRun,
        importPurge: PlatformImportPurge,
      ) => [
        seedCategoryTreeJob(categories),
        seedAttributesJob(attributes),
        sweepOrphanImagesJob(sweep),
        reevaluateTagsJob(reevaluate),
        reconcileTagsJob(reconcile),
        sendOfferOwnerNoticesJob(notices),
        platformImportRunJob(importRun),
        purgePlatformImportsJob(importPurge),
      ],
    ),
    // Certification events consumed (design 5.5, 9.5; slice 12).
    registerSubscriptionsFrom(
      'catalog',
      [ReevaluateFromCertification, WarnOfferOwnersOfExpiry],
      (reevaluate: ReevaluateFromCertification, warn: WarnOfferOwnersOfExpiry) => [
        ...certificationSubscriptions(reevaluate),
        ...certificateExpiryNoticeSubscriptions(warn),
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
          publishedProductImages,
          pendingProductRevisions,
          sellerProductOwners,
          productsForLinking,
        }),
    },
    useCaseProvider(OfferSearchFactsQuery, { unitOfWork: true, searchReader: true }),
    useCaseProvider(PublishedOfferIdsQuery, { unitOfWork: true, searchReader: true }),
    {
      provide: CATALOG_INDEX_FACADE,
      inject: [OfferSearchFactsQuery, PublishedOfferIdsQuery],
      useFactory: (facts: OfferSearchFactsQuery, published: PublishedOfferIdsQuery) =>
        new CatalogIndexFacadeImplementation(facts, published),
    },
    {
      provide: CATALOG_ASSISTANT_FACADE,
      inject: [CategoryTreeQuery],
      useFactory: (tree: CategoryTreeQuery) => new CatalogAssistantFacadeImplementation(tree),
    },
  ],
  exports: [CATALOG_FACADE, CATALOG_INDEX_FACADE, CATALOG_ASSISTANT_FACADE],
})
export class CatalogModule {}
