import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { PAGE_REPOSITORY, type PageRepository } from '../application/ports/page.repository';
import { SLIDE_REPOSITORY, type SlideRepository } from '../application/ports/slide.repository';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  CATALOG_ASSISTANT_FACADE,
  CATALOG_FACADE,
  type CatalogAssistantFacade,
  type CatalogFacade,
} from '../../catalog';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { SLIDE_TARGETS, type SlideTargets } from '../application/ports/slide-targets';
import { FacadeSlideTargets } from './facade-slide-targets';
import { PrismaPageRepository } from './prisma-page.repository';
import { PrismaSlideRepository } from './prisma-slide.repository';

/** Binds the ports of the storefront. Only this layer may reach `PrismaService`. */
export const storefrontProviders: readonly FactoryProvider[] = [
  {
    provide: PAGE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PageRepository => new PrismaPageRepository(prisma),
  },
  {
    provide: SLIDE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SlideRepository => new PrismaSlideRepository(prisma),
  },
  {
    provide: SLIDE_TARGETS,
    inject: [CATALOG_FACADE, CATALOG_ASSISTANT_FACADE, SELLERS_FACADE, MarketRegistry],
    useFactory: (
      catalog: CatalogFacade,
      categories: CatalogAssistantFacade,
      sellers: SellersFacade,
      markets: MarketRegistry,
    ): SlideTargets => new FacadeSlideTargets(catalog, categories, sellers, markets),
  },
];
