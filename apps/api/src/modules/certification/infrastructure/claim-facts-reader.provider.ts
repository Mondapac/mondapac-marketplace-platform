import type { FactoryProvider } from '@nestjs/common';
import {
  RAW_READ_PORT,
  type RawReadPort,
} from '../../../platform/persistence/raw-reads/raw-read-port';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { CLAIM_FACTS_READER } from '../application/ports/tokens';
import { PrismaClaimFactsReader } from './prisma-claim-facts.reader';

/**
 * The claim facts reader: the raw read reader on the module's own port, which the module binds
 * with `PersistenceModule.rawReadFor('certification')` (ADR-0030).
 */
export const claimFactsReaderProvider: FactoryProvider = {
  provide: CLAIM_FACTS_READER,
  inject: [UNIT_OF_WORK, RAW_READ_PORT],
  useFactory: (unitOfWork: UnitOfWork, rawReads: RawReadPort) =>
    new PrismaClaimFactsReader(unitOfWork, rawReads),
};
