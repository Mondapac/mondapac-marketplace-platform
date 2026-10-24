import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { CERTIFIED_CATEGORIES_READER } from '../application/ports/tokens';
import { PrismaCertifiedCategoriesReader } from './prisma-certified-categories.reader';

/** The certified-categories reader: the Prisma reader, each call in a read-only unit of its own. */
export const certifiedCategoriesReaderProvider: FactoryProvider = {
  provide: CERTIFIED_CATEGORIES_READER,
  inject: [UNIT_OF_WORK, PrismaService],
  useFactory: (unitOfWork: UnitOfWork, prisma: PrismaService) =>
    new PrismaCertifiedCategoriesReader(unitOfWork, prisma),
};
