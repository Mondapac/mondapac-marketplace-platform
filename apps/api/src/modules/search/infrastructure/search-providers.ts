import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  RAW_READ_PORT,
  type RawReadPort,
} from '../../../platform/persistence/raw-reads/raw-read-port';
import { CATALOG_FACADE, CATALOG_INDEX_FACADE } from '../../catalog';
import type { CatalogFacade, CatalogIndexFacade } from '../../catalog';
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
import { ConfigSearchPolicy } from './config-search-policy';
import { FacadeOfferFeed } from './facade-offer-feed';
import { FacadePublicVisibility } from './facade-public-visibility';
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
];
