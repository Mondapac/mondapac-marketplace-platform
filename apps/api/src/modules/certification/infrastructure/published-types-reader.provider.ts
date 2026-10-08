import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { PUBLISHED_TYPES_READER } from '../application/ports/tokens';
import { PrismaPublishedTypesReader } from './prisma-published-types.reader';
import { UnitPublishedTypesReader } from './unit-published-types.reader';

/** The published types reader: the Prisma reader, each call in a read-only unit of its own. */
export const publishedTypesReaderProvider: FactoryProvider = {
  provide: PUBLISHED_TYPES_READER,
  inject: [UNIT_OF_WORK, PrismaService],
  useFactory: (unitOfWork: UnitOfWork, prisma: PrismaService) =>
    new UnitPublishedTypesReader(unitOfWork, new PrismaPublishedTypesReader(prisma)),
};
