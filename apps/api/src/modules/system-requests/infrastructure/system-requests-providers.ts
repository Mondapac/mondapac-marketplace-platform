import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { POLICY_REPOSITORY, type PolicyRepository } from '../application/ports/policy.repository';
import {
  REQUEST_REPOSITORY,
  type RequestRepository,
} from '../application/ports/request.repository';
import { PrismaPolicyRepository } from './prisma-policy.repository';
import { PrismaRequestRepository } from './prisma-request.repository';

/** Binds the ports of system-requests. Only this layer may reach `PrismaService`. */
export const systemRequestsProviders: readonly FactoryProvider[] = [
  {
    provide: REQUEST_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RequestRepository => new PrismaRequestRepository(prisma),
  },
  {
    provide: POLICY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PolicyRepository => new PrismaPolicyRepository(prisma),
  },
];
