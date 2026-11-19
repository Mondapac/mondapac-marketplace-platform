import type { FactoryProvider } from '@nestjs/common';
import { ExceljsSheetWriter, SHEET_WRITER, type SheetWriter } from '../../../platform/list-export';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { IDENTITY_FACADE, type IdentityFacade } from '../../identity';
import { ADMIN_NAMES, type AdminNames } from '../application/ports/admin-names';
import { POLICY_REPOSITORY, type PolicyRepository } from '../application/ports/policy.repository';
import {
  REQUEST_REPOSITORY,
  type RequestRepository,
} from '../application/ports/request.repository';
import { FacadeAdminNames } from './facade-admin-names';
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
  {
    provide: ADMIN_NAMES,
    inject: [IDENTITY_FACADE],
    useFactory: (identity: IdentityFacade): AdminNames => new FacadeAdminNames(identity),
  },
  // The XLSX writer of the queue's export (the shared list export, ExcelJS).
  { provide: SHEET_WRITER, useFactory: (): SheetWriter => new ExceljsSheetWriter() },
];
