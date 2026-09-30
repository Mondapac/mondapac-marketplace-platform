import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';

/**
 * The single Prisma client of the process (ADR-0004). It connects lazily on first use.
 * Import it only from `platform/persistence` and a module's `infrastructure/` layer.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
