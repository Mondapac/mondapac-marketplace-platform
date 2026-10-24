import type { FactoryProvider } from '@nestjs/common';
import { CATALOG_ASSISTANT_FACADE, CATALOG_FACADE } from '../../catalog';
import type { CatalogAssistantFacade, CatalogFacade } from '../../catalog';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { LINK_TARGETS, type LinkTargets } from '../application/ports/link-targets';
import { PAGE_REPOSITORY, type PageRepository } from '../application/ports/page.repository';
import { SLIDE_REPOSITORY, type SlideRepository } from '../application/ports/slide.repository';
import { FacadeLinkTargets } from './facade-link-targets';
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
    provide: LINK_TARGETS,
    inject: [CATALOG_ASSISTANT_FACADE, CATALOG_FACADE, SELLERS_FACADE],
    useFactory: (
      tree: CatalogAssistantFacade,
      catalog: CatalogFacade,
      sellers: SellersFacade,
    ): LinkTargets => new FacadeLinkTargets(tree, catalog, sellers),
  },
];
