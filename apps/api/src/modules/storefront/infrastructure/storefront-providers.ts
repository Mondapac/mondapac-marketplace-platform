import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { PAGE_REPOSITORY, type PageRepository } from '../application/ports/page.repository';
import { PrismaPageRepository } from './prisma-page.repository';

/** Binds the ports of the storefront. Only this layer may reach `PrismaService`. */
export const storefrontProviders: readonly FactoryProvider[] = [
  {
    provide: PAGE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PageRepository => new PrismaPageRepository(prisma),
  },
];
