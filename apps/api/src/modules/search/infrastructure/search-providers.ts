import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  RAW_READ_PORT,
  type RawReadPort,
} from '../../../platform/persistence/raw-reads/raw-read-port';
import { CATALOG_FACADE, CATALOG_INDEX_FACADE } from '../../catalog';
import type { CatalogFacade, CatalogIndexFacade } from '../../catalog';
import { INVENTORY_FACADE, type InventoryFacade } from '../../inventory';
import { ORDERING_RANKING_FACADE, type OrderingRankingFacade } from '../../ordering';
import {
  PRICING_FACADE,
  PRICING_SPECIALS_FACADE,
  type PricingFacade,
  type PricingSpecialsFacade,
} from '../../pricing';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import {
  OFFER_DOCUMENT_REPOSITORY,
  type OfferDocumentRepository,
} from '../application/ports/offer-document.repository';
import { OFFER_FEED, type OfferFeed } from '../application/ports/offer-feed';
import {
  OFFER_SEARCH_READER,
  type OfferSearchReader,
} from '../application/ports/offer-search.reader';
import { PUBLIC_VISIBILITY, type PublicVisibility } from '../application/ports/public-visibility';
import { SEARCH_POLICY, type SearchPolicy } from '../application/ports/search-policy';
import {
  SELLER_ELIGIBILITY,
  type SellerEligibility,
} from '../application/ports/seller-eligibility';
import {
  SHELF_DOCUMENTS_READER,
  type ShelfDocumentsReader,
} from '../application/ports/shelf-documents.reader';
import { SHELF_SOURCES, type ShelfSources } from '../application/ports/shelf-sources';
import {
  PRODUCT_DETAIL_SOURCES,
  type ProductDetailSources,
} from '../application/ports/product-detail-sources';
import { FacadeProductDetailSources } from './facade-product-detail-sources';
import { FacadeShelfSources } from './facade-shelf-sources';
import { FacadePublishedVariants } from './facade-published-variants';
import {
  PUBLISHED_VARIANTS,
  type PublishedVariants,
} from '../application/ports/published-variants';
import { PrismaShelfDocumentsReader } from './prisma-shelf-documents.reader';
import { ConfigSearchPolicy } from './config-search-policy';
import { FacadeOfferFeed } from './facade-offer-feed';
import { FacadePublicVisibility } from './facade-public-visibility';
import { FacadeSellerEligibility } from './facade-seller-eligibility';
import { PrismaOfferDocumentRepository } from './prisma-offer-document.repository';
import { RawOfferSearchReader } from './raw-offer-search.reader';

/**
 * Binds the ports of search. Only this layer may reach `PrismaService`, the module's own raw read
 * port (bound in the module with `PersistenceModule.rawReadFor('search')`) and the facades of
 * other modules.
 */
export const searchProviders: readonly FactoryProvider[] = [
  {
    provide: OFFER_DOCUMENT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferDocumentRepository =>
      new PrismaOfferDocumentRepository(prisma),
  },
  {
    provide: OFFER_SEARCH_READER,
    inject: [RAW_READ_PORT],
    useFactory: (rawReads: RawReadPort): OfferSearchReader => new RawOfferSearchReader(rawReads),
  },
  {
    provide: SEARCH_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): SearchPolicy => new ConfigSearchPolicy(markets),
  },
  {
    provide: OFFER_FEED,
    inject: [CATALOG_INDEX_FACADE],
    useFactory: (catalog: CatalogIndexFacade): OfferFeed => new FacadeOfferFeed(catalog),
  },
  {
    provide: PUBLIC_VISIBILITY,
    inject: [CATALOG_FACADE, SELLERS_FACADE],
    useFactory: (catalog: CatalogFacade, sellers: SellersFacade): PublicVisibility =>
      new FacadePublicVisibility(catalog, sellers),
  },
  {
    provide: SELLER_ELIGIBILITY,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerEligibility => new FacadeSellerEligibility(sellers),
  },
  {
    provide: SHELF_DOCUMENTS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ShelfDocumentsReader =>
      new PrismaShelfDocumentsReader(prisma),
  },
  {
    provide: SHELF_SOURCES,
    inject: [ORDERING_RANKING_FACADE, PRICING_SPECIALS_FACADE],
    useFactory: (ordering: OrderingRankingFacade, pricing: PricingSpecialsFacade): ShelfSources =>
      new FacadeShelfSources(ordering, pricing),
  },
  {
    provide: PUBLISHED_VARIANTS,
    inject: [CATALOG_FACADE],
    useFactory: (catalog: CatalogFacade): PublishedVariants => new FacadePublishedVariants(catalog),
  },
  {
    provide: PRODUCT_DETAIL_SOURCES,
    inject: [CATALOG_FACADE, PRICING_FACADE, INVENTORY_FACADE, SELLERS_FACADE],
    useFactory: (
      catalog: CatalogFacade,
      pricing: PricingFacade,
      inventory: InventoryFacade,
      sellers: SellersFacade,
    ): ProductDetailSources => new FacadeProductDetailSources(catalog, pricing, inventory, sellers),
  },
];
