import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * The only database access offered to code outside the persistence layer: a connectivity
 * check. Everything else goes through a module's own infrastructure/ repositories.
 */
@Injectable()
export class DatabaseProbe {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolves when the database answers a trivial query; rejects otherwise. */
  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
