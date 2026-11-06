import type { FactoryProvider } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { AUDIT_WRITER, type AuditWriter } from '../../../platform/audit/audit-writer';
import { USE_CASE_GATE, type UseCaseGate } from '../../../platform/authz';
import { CLOCK } from '../../../platform/clock/clock.module';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CategoryRetirementRepository } from '../application/ports/category-retirement.repository';
import { CATEGORY_RETIREMENT_REPOSITORY } from '../application/ports/tokens';
import { AssertCategoriesRetirableSystem } from '../application/use-cases/assert-categories-retirable-system.use-case';
import { AssertCategoriesRetirable } from '../application/use-cases/assert-categories-retirable.use-case';
import { PlatformCategoriesRetired } from '../application/use-cases/platform-categories-retired.use-case';
import { PrismaCategoryRetirementRepository } from './prisma-category-retirement.repository';

/** `assertCategoriesRetirable` (the pair) and the `platformCategoriesRetired` backstop (C-4, B2). */
export const categoryRetirementProviders: FactoryProvider[] = [
  {
    provide: CATEGORY_RETIREMENT_REPOSITORY,
    inject: [UNIT_OF_WORK, PrismaService],
    useFactory: (unitOfWork: UnitOfWork, prisma: PrismaService) =>
      new PrismaCategoryRetirementRepository(unitOfWork, prisma),
  },
  ...[AssertCategoriesRetirable, AssertCategoriesRetirableSystem].map((type): FactoryProvider => ({
    provide: type,
    inject: [USE_CASE_GATE, CATEGORY_RETIREMENT_REPOSITORY],
    useFactory: (gate: UseCaseGate, repository: CategoryRetirementRepository) =>
      new type(gate, repository),
  })),
  {
    provide: PlatformCategoriesRetired,
    inject: [USE_CASE_GATE, UNIT_OF_WORK, CATEGORY_RETIREMENT_REPOSITORY, AUDIT_WRITER, CLOCK],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: UnitOfWork,
      repository: CategoryRetirementRepository,
      audit: AuditWriter,
      clock: Clock,
    ) => new PlatformCategoriesRetired(gate, { unitOfWork, repository, audit, clock }),
  },
];
