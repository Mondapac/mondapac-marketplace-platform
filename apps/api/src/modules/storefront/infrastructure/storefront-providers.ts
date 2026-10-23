import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { PAGE_REPOSITORY, type PageRepository } from '../application/ports/page.repository';
import { SLIDE_REPOSITORY, type SlideRepository } from '../application/ports/slide.repository';
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
];
