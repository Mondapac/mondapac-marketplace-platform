import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { CATALOG_FACADE, type CatalogFacade } from '../../catalog';
import { CERTIFICATION_FACADE, type CertificationFacade } from '../../certification';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { BLOG_LINKS, type BlogLinks } from '../application/ports/blog-links';
import { BLOG_POLICY, type BlogPolicy } from '../application/ports/blog-policy';
import { BLOG_REPOSITORY, type BlogRepository } from '../application/ports/blog.repository';
import { ConfigBlogPolicy } from './config-blog-policy';
import { FacadeBlogLinks } from './facade-blog-links';
import { PrismaBlogRepository } from './prisma-blog.repository';

/** Binds the ports of the blog. Only this layer may reach `PrismaService`. */
export const blogProviders: readonly FactoryProvider[] = [
  {
    provide: BLOG_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BlogRepository => new PrismaBlogRepository(prisma),
  },
  {
    provide: BLOG_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): BlogPolicy => new ConfigBlogPolicy(markets),
  },
  {
    provide: BLOG_LINKS,
    inject: [CATALOG_FACADE, SELLERS_FACADE, CERTIFICATION_FACADE],
    useFactory: (
      catalog: CatalogFacade,
      sellers: SellersFacade,
      certification: CertificationFacade,
    ): BlogLinks => new FacadeBlogLinks(catalog, sellers, certification),
  },
];
