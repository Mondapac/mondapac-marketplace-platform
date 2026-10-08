import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../../platform/subject-keys/subject-key-service';
import { ROLE_SEED, type RoleSeed } from '../../application/ports/role-seed';
import {
  SELLER_ACCESS_REPOSITORY,
  type SellerAccessRepository,
} from '../../application/ports/seller-access.repository';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
  SELLER_MEMBERSHIP_REPOSITORY,
  type RoleAssignmentRepository,
  type RoleRepository,
  type SellerMembershipRepository,
} from '../../application/ports/seller-team.repository';
import { CheckedInRoleSeed } from '../seed/checked-in-role-seed';
import { PrismaSellerAccessRepository } from './prisma-seller-access.repository';
import {
  PrismaRoleAssignmentRepository,
  PrismaRoleRepository,
  PrismaSellerMembershipRepository,
} from './prisma-seller-team.repository';

/**
 * Binds the seller access, membership, role and assignment ports of slice 5, and the role seed. They live in
 * `infrastructure/` because only this layer may reach `PrismaService` and the SubjectKeyService
 * (dependency-cruiser `persistence-internals-are-private`, `subject-keys-only-in-infrastructure`).
 */
export const sellerProviders: readonly FactoryProvider[] = [
  {
    provide: SELLER_ACCESS_REPOSITORY,
    inject: [PrismaService, SUBJECT_KEY_SERVICE],
    useFactory: (prisma: PrismaService, subjectKeys: SubjectKeyService): SellerAccessRepository =>
      new PrismaSellerAccessRepository(prisma, subjectKeys),
  },
  {
    provide: SELLER_MEMBERSHIP_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerMembershipRepository =>
      new PrismaSellerMembershipRepository(prisma),
  },
  {
    provide: ROLE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RoleRepository => new PrismaRoleRepository(prisma),
  },
  {
    provide: ROLE_ASSIGNMENT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RoleAssignmentRepository =>
      new PrismaRoleAssignmentRepository(prisma),
  },
  {
    // The checked-in seed, checked at boot (identity design 5.6).
    provide: ROLE_SEED,
    useFactory: (): RoleSeed => new CheckedInRoleSeed(),
  },
];
