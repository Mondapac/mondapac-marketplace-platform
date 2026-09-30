import { Global, Module } from '@nestjs/common';
import { DatabaseProbe } from './database-probe';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, DatabaseProbe],
  exports: [PrismaService, DatabaseProbe],
})
export class PersistenceModule {}
