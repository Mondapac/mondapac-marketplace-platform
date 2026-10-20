import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CatalogModule } from '../catalog';
import { OrderingModule } from '../ordering';
import { PricingModule } from '../pricing';
import { SellersModule } from '../sellers';
import { OFFER_DOCUMENT_REPOSITORY } from './application/ports/offer-document.repository';
import { OFFER_FEED } from './application/ports/offer-feed';
import { OFFER_SEARCH_READER } from './application/ports/offer-search.reader';
import { PUBLIC_VISIBILITY } from './application/ports/public-visibility';
import { SEARCH_POLICY } from './application/ports/search-policy';
import { SHELF_DOCUMENTS_READER } from './application/ports/shelf-documents.reader';
import { SHELF_SOURCES } from './application/ports/shelf-sources';
import { PUBLISHED_VARIANTS } from './application/ports/published-variants';
import type { ShelfDependencies } from './application/shelf-dependencies';
import { ListBestsellers } from './application/use-cases/list-bestsellers.use-case';
import { ListSpecials } from './application/use-cases/list-specials.use-case';
import type { SearchDependencies } from './application/search-dependencies';
import { RebuildOfferIndex } from './application/use-cases/rebuild-offer-index.use-case';
import { SearchProducts } from './application/use-cases/search-products.use-case';
import { SyncOfferDocuments } from './application/use-cases/sync-offer-documents.use-case';
import { searchProviders } from './infrastructure/search-providers';
import { rebuildIndexJob } from './presentation/jobs/rebuild-offer-index.job';
import { SearchController } from './presentation/search.controller';
import { ShelfController } from './presentation/shelf.controller';
import { catalogIndexSubscriptions } from './presentation/subscribers/catalog-index.subscriptions';
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
  ['clock', CLOCK],
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

/**
 * Product search (speed mode, Phase 6 package 2; docs/modules/search/search.md): a read model
 * `search.offer_documents` kept fresh from catalog's events and rebuilt by a job, and the public
 * `GET /search/products` over PostgreSQL full-text search (ADR-0004). Storefront reads: the
 * best-sellers and specials shelves (`GET /search/bestsellers`, `GET /search/specials`) over the
 * same read model, ordered by ordering's ranking and pricing's specials. The same three reads are
 * the buyer assistant's READ tools (`SEARCH_ASSISTANT_FACADE`).
 */
@Module({
  imports: [CatalogModule, SellersModule, OrderingModule, PricingModule],
  controllers: [SearchController, ShelfController],
  providers: [
    PersistenceModule.rawReadFor('search'),
    ...searchProviders,
    ...[SearchProducts, SyncOfferDocuments, RebuildOfferIndex].map((type) =>
      useCaseProvider(type as UseCaseClass<unknown>),
    ),
    shelfProvider(ListBestsellers),
    shelfProvider(ListSpecials),
    {
      provide: SEARCH_ASSISTANT_FACADE,
      inject: [SearchProducts, ListBestsellers, ListSpecials],
      useFactory: (search: SearchProducts, bestsellers: ListBestsellers, specials: ListSpecials) =>
        new SearchAssistantFacadeImplementation(search, bestsellers, specials),
    },
    registerSubscriptionsFrom('search', [SyncOfferDocuments], (sync: SyncOfferDocuments) =>
      catalogIndexSubscriptions(sync),
    ),
    registerJobsFrom('search', [RebuildOfferIndex], (rebuild: RebuildOfferIndex) => [
      rebuildIndexJob(rebuild),
    ]),
  ],
  exports: [SEARCH_ASSISTANT_FACADE],
})
export class SearchModule {}
