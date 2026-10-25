import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CatalogModule } from '../catalog';
import { CertificationModule } from '../certification';
import { EngagementModule } from '../engagement';
import { InventoryModule } from '../inventory';
import { OrderingModule } from '../ordering';
import { PricingModule } from '../pricing';
import { SellersModule } from '../sellers';
import { OFFER_DOCUMENT_REPOSITORY } from './application/ports/offer-document.repository';
import { OFFER_FEED } from './application/ports/offer-feed';
import { OFFER_SEARCH_READER } from './application/ports/offer-search.reader';
import { PRODUCT_IMAGES } from './application/ports/product-images';
import { STORE_RESOLVER } from './application/ports/store-resolver';
import { PERSONAL_SIGNALS } from './application/ports/personal-signals';
import { PUBLIC_VISIBILITY } from './application/ports/public-visibility';
import { SEARCH_POLICY } from './application/ports/search-policy';
import { SELLER_ELIGIBILITY } from './application/ports/seller-eligibility';
import { SHELF_DOCUMENTS_READER } from './application/ports/shelf-documents.reader';
import { SHELF_SOURCES } from './application/ports/shelf-sources';
import { PRODUCT_DETAIL_SOURCES } from './application/ports/product-detail-sources';
import { PUBLISHED_VARIANTS } from './application/ports/published-variants';
import type { ProductDetailDependencies } from './application/product-detail-dependencies';
import type { RecommendationDependencies } from './application/recommendation-dependencies';
import type { ShelfDependencies } from './application/shelf-dependencies';
import { ListBoughtTogether } from './application/use-cases/list-bought-together.use-case';
import { ListBestsellers } from './application/use-cases/list-bestsellers.use-case';
import { ListForYouGuest } from './application/use-cases/list-for-you-guest.use-case';
import { ListForYou } from './application/use-cases/list-for-you.use-case';
import { ListRecentlyViewedGuest } from './application/use-cases/list-recently-viewed-guest.use-case';
import { ListRecentlyViewed } from './application/use-cases/list-recently-viewed.use-case';
import { ListSpecials } from './application/use-cases/list-specials.use-case';
import type { SearchDependencies } from './application/search-dependencies';
import { RebuildOfferIndex } from './application/use-cases/rebuild-offer-index.use-case';
import { ViewProductDetail } from './application/use-cases/view-product-detail.use-case';
import { SearchProducts } from './application/use-cases/search-products.use-case';
import { SyncOfferDocuments } from './application/use-cases/sync-offer-documents.use-case';
import { searchProviders } from './infrastructure/search-providers';
import { rebuildIndexJob } from './presentation/jobs/rebuild-offer-index.job';
import { ForYouController } from './presentation/for-you.controller';
import { RecentlyViewedController } from './presentation/recently-viewed.controller';
import { ProductDetailController } from './presentation/product-detail.controller';
import { SearchController } from './presentation/search.controller';
import { BoughtTogetherController } from './presentation/bought-together.controller';
import { ShelfController } from './presentation/shelf.controller';
import { catalogIndexSubscriptions } from './presentation/subscribers/catalog-index.subscriptions';
import { sellerAccessIndexSubscriptions } from './presentation/subscribers/seller-access-index.subscriptions';
import { SEARCH_ASSISTANT_FACADE } from './contracts';
import { SearchAssistantFacadeImplementation } from './presentation/search-assistant.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: SearchDependencies) => U;

const PORTS: readonly [keyof SearchDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['documents', OFFER_DOCUMENT_REPOSITORY],
  ['reader', OFFER_SEARCH_READER],
  ['policy', SEARCH_POLICY],
  ['feed', OFFER_FEED],
  ['visibility', PUBLIC_VISIBILITY],
  ['sellers', SELLER_ELIGIBILITY],
  ['clock', CLOCK],
  ['shelves', SHELF_DOCUMENTS_READER],
  ['stores', STORE_RESOLVER],
  ['images', PRODUCT_IMAGES],
];

/** Every search use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as SearchDependencies,
      ),
  };
}

const SHELF_PORTS: readonly [keyof ShelfDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['reader', OFFER_SEARCH_READER],
  ['shelves', SHELF_DOCUMENTS_READER],
  ['sources', SHELF_SOURCES],
  ['visibility', PUBLIC_VISIBILITY],
  ['policy', SEARCH_POLICY],
  ['variants', PUBLISHED_VARIANTS],
  ['images', PRODUCT_IMAGES],
];

/** The two shelf use cases share their own dependency object. */
function shelfProvider<U>(
  type: new (gate: UseCaseGate, deps: ShelfDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...SHELF_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          SHELF_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as ShelfDependencies,
      ),
  };
}

const RECOMMENDATION_PORTS: readonly [keyof RecommendationDependencies, InjectionToken][] = [
  ...SHELF_PORTS,
  ['signals', PERSONAL_SIGNALS],
];

/** The four personal shelf use cases (customer and guest) share their own dependency object. */
function recommendationProvider<U>(
  type: new (gate: UseCaseGate, deps: RecommendationDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...RECOMMENDATION_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          RECOMMENDATION_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as RecommendationDependencies,
      ),
  };
}

const DETAIL_PORTS: readonly [keyof ProductDetailDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['shelves', SHELF_DOCUMENTS_READER],
  ['sources', PRODUCT_DETAIL_SOURCES],
  ['visibility', PUBLIC_VISIBILITY],
  ['policy', SEARCH_POLICY],
  ['variants', PUBLISHED_VARIANTS],
  ['images', PRODUCT_IMAGES],
];

/** The product page read has its own dependency object. */
function productDetailProvider<U>(
  type: new (gate: UseCaseGate, deps: ProductDetailDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...DETAIL_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          DETAIL_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as ProductDetailDependencies,
      ),
  };
}

/**
 * Product search (speed mode, Phase 6 package 2; docs/modules/search/search.md): a read model
 * `search.offer_documents` kept fresh from catalog's events and rebuilt by a job, and the public
 * `GET /search/products` over PostgreSQL full-text search (ADR-0004). Storefront reads: the
 * best-sellers and specials shelves (`GET /search/bestsellers`, `GET /search/specials`) over the
 * same read model, ordered by ordering's ranking and pricing's specials. The same three reads are
 * the buyer assistant's READ tools (`SEARCH_ASSISTANT_FACADE`). The product page's data
 * (`GET /search/product-detail/:productId`) is composed from catalog, pricing, inventory and
 * sellers. The personal shelves (personalization package 1d-1) are the signed-in customer's or
 * guest's "for you" (`GET /search/for-you`) and "recently viewed"
 * (`GET /engagement/recommendations/recently-viewed`), read from `engagement`'s facade.
 */
@Module({
  imports: [
    CatalogModule,
    SellersModule,
    OrderingModule,
    PricingModule,
    InventoryModule,
    EngagementModule,
    CertificationModule,
  ],
  controllers: [
    SearchController,
    ShelfController,
    BoughtTogetherController,
    ProductDetailController,
    ForYouController,
    RecentlyViewedController,
  ],
  providers: [
    PersistenceModule.rawReadFor('search'),
    ...searchProviders,
    ...[SearchProducts, SyncOfferDocuments, RebuildOfferIndex].map((type) =>
      useCaseProvider(type as UseCaseClass<unknown>),
    ),
    shelfProvider(ListBestsellers),
    shelfProvider(ListSpecials),
    shelfProvider(ListBoughtTogether),
    recommendationProvider(ListForYou),
    recommendationProvider(ListForYouGuest),
    recommendationProvider(ListRecentlyViewed),
    recommendationProvider(ListRecentlyViewedGuest),
    productDetailProvider(ViewProductDetail),
    {
      provide: SEARCH_ASSISTANT_FACADE,
      inject: [SearchProducts, ListBestsellers, ListSpecials],
      useFactory: (search: SearchProducts, bestsellers: ListBestsellers, specials: ListSpecials) =>
        new SearchAssistantFacadeImplementation(search, bestsellers, specials),
    },
    registerSubscriptionsFrom('search', [SyncOfferDocuments], (sync: SyncOfferDocuments) => [
      ...catalogIndexSubscriptions(sync),
      ...sellerAccessIndexSubscriptions(sync),
    ]),
    registerJobsFrom('search', [RebuildOfferIndex], (rebuild: RebuildOfferIndex) => [
      rebuildIndexJob(rebuild),
    ]),
  ],
  exports: [SEARCH_ASSISTANT_FACADE],
})
export class SearchModule {}
