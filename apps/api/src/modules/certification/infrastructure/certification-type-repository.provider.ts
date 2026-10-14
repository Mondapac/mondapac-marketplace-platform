import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { CERTIFICATION_TYPE_REPOSITORY } from '../application/ports/certification-type.repository';
import { PrismaCertificationTypeRepository } from './prisma-certification-type.repository';

/** The write side of the type registry that the seed uses, on the module's own tables. */
export const certificationTypeRepositoryProvider: FactoryProvider = {
  provide: CERTIFICATION_TYPE_REPOSITORY,
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => new PrismaCertificationTypeRepository(prisma),
};
