import { CertificationModule } from '../certification';
import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
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
import { SELLER_ELIGIBILITY_READER } from './application/ports/seller-eligibility.reader';
import { OwnOfferCreateOnPlatformProduct } from './application/use-cases/own-offer-create-on-platform-product.use-case';
import { OwnOfferEdit } from './application/use-cases/own-offer-edit.use-case';
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
import { CATEGORY_SEED } from './application/ports/category-seed';
import { PLATFORM_CATEGORY_REPOSITORY } from './application/ports/platform-category.repository';
import { SeedAttributes } from './application/use-cases/seed-attributes.use-case';
import { OfferSellUnitsSystemQuery } from './application/use-cases/offer-sell-units-system.use-case';
import { OfferSellUnitsQuery } from './application/use-cases/offer-sell-units.use-case';
import { SeedCategoryTree } from './application/use-cases/seed-category-tree.use-case';
import { CATALOG_FACADE } from './contracts/catalog.facade';
import { CATALOG_EVENTS } from './domain/events';
import {
  PRODUCT_TYPE_POINT,
  isProductTypeHandler,
  type ProductTypeHandler,
} from './domain/product-type-handler';
import { configurableProductType } from './domain/product-types/configurable';
import { simpleProductType } from './domain/product-types/simple';
import { PlatformProductController } from './presentation/platform-product.controller';
import { OwnOfferController } from './presentation/own-offer.controller';
import { OwnProductsList } from './application/use-cases/own-products-list.use-case';
import { OwnProductRead } from './application/use-cases/own-product-read.use-case';
import { OwnOffersList } from './application/use-cases/own-offers-list.use-case';
import { OwnOfferRead } from './application/use-cases/own-offer-read.use-case';
import { OWN_CATALOG_READER } from './application/ports/own-catalog.reader';
import { OwnProductController } from './presentation/own-product.controller';
import { OwnProductCreate } from './application/use-cases/own-product-create.use-case';
import { OwnProductSaveDraft } from './application/use-cases/own-product-save-draft.use-case';
import { OwnProductSubmit } from './application/use-cases/own-product-submit.use-case';
import { catalogProviders } from './infrastructure/catalog-providers';
import { assertCatalogConfigured } from './infrastructure/market-config-boot-check';
import { seedAttributesJob } from './presentation/jobs/seed-attributes.job';
import { CatalogFacadeImplementation } from './presentation/catalog.facade';
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
  offers: OFFER_REPOSITORY,
  eligibility: SELLER_ELIGIBILITY_READER,
  allowedTypes: ALLOWED_PRODUCT_TYPES_READER,
  ownReader: OWN_CATALOG_READER,
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
  controllers: [PlatformProductController, OwnOfferController, OwnProductController],
  imports: [CertificationModule, SellersModule],
  providers: [
    PersistenceModule.outboxWriterFor('catalog'),
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
      inject: [ATTRIBUTE_REPOSITORY, CATALOG_MARKET_POLICY, PRODUCT_TYPE_LOOKUP],
      useFactory: (
        attributes: AttributeRepository,
        policy: CatalogMarketPolicy,
        handlerFor: ProductTypeLookup,
      ): FreezeRevision => new FreezeRevision({ attributes, policy, handlerFor }),
    },
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
    }),
    useCaseProvider(OwnProductsList, { unitOfWork: true, ownReader: true, policy: true }),
    useCaseProvider(OwnProductRead, {
      unitOfWork: true,
      products: true,
      workingCopies: true,
      revisions: true,
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
    registerJobsFrom(
      'catalog',
      [SeedCategoryTree, SeedAttributes],
      (categories: SeedCategoryTree, attributes: SeedAttributes) => [
        seedCategoryTreeJob(categories),
        seedAttributesJob(attributes),
      ],
    ),
    useCaseProvider(OfferSellUnitsQuery, { unitOfWork: true, reader: true }),
    useCaseProvider(OfferSellUnitsSystemQuery, { unitOfWork: true, reader: true }),
    {
      provide: CATALOG_FACADE,
      inject: [OfferSellUnitsQuery, OfferSellUnitsSystemQuery],
      useFactory: (
        offerSellUnits: OfferSellUnitsQuery,
        offerSellUnitsSystem: OfferSellUnitsSystemQuery,
      ) => new CatalogFacadeImplementation({ offerSellUnits, offerSellUnitsSystem }),
    },
  ],
  exports: [CATALOG_FACADE],
})
export class CatalogModule {}
