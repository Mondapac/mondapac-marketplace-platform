import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { CATALOG_FACADE, type CatalogFacade } from '../../catalog';
import { CERTIFICATION_FACADE, type CertificationFacade } from '../../certification';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import {
  BLOG_IMAGE_PROCESSOR,
  type BlogImageProcessor,
} from '../application/ports/blog-image-processor';
import { BLOG_LINKS, type BlogLinks } from '../application/ports/blog-links';
import { BLOG_MEDIA_STORE, type BlogMediaStore } from '../application/ports/blog-media.store';
import { BLOG_POLICY, type BlogPolicy } from '../application/ports/blog-policy';
import { BLOG_REPOSITORY, type BlogRepository } from '../application/ports/blog.repository';
import {
  ADMIN_POST_LIST_READER,
  type AdminPostListReader,
} from '../application/ports/admin-post-list.reader';
import { ExceljsSheetWriter, SHEET_WRITER, type SheetWriter } from '../../../platform/list-export';
import { PrismaAdminPostListReader } from './prisma-admin-post-list.reader';
import { ConfigBlogPolicy } from './config-blog-policy';
import { FacadeBlogLinks } from './facade-blog-links';
import { PrismaBlogMediaStore } from './prisma-blog-media.store';
import { PrismaBlogRepository } from './prisma-blog.repository';
import { SharpBlogImageProcessor } from './sharp-blog-image-processor';

/** Binds the ports of the blog. Only this layer may reach `PrismaService`. */
export const blogProviders: readonly FactoryProvider[] = [
  {
    provide: BLOG_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BlogRepository => new PrismaBlogRepository(prisma),
  },
  {
    provide: ADMIN_POST_LIST_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AdminPostListReader =>
      new PrismaAdminPostListReader(prisma),
  },
  {
    provide: SHEET_WRITER,
    useFactory: (): SheetWriter => new ExceljsSheetWriter(),
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
  {
    provide: BLOG_MEDIA_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BlogMediaStore => new PrismaBlogMediaStore(prisma),
  },
  {
    provide: BLOG_IMAGE_PROCESSOR,
    useFactory: (): BlogImageProcessor => new SharpBlogImageProcessor(),
  },
];
