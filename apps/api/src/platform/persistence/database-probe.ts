import { Injectable } from '@nestjs/common';
import { findRoleProblems, type RoleProblem } from './database-role-check';
import { PrismaService } from './prisma.service';

/**
 * The only database access offered to code outside the persistence layer: a connectivity
 * check and the start-up role check. Everything else goes through a module's own
 * infrastructure/ repositories.
 */
@Injectable()
export class DatabaseProbe {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolves when the database answers a trivial query; rejects otherwise. */
  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  /**
   * What is wrong with the role the application is connected as (docs/design/data/platform.md
   * 10.8); empty when nothing is. `main.ts` runs it once before the server listens.
   */
  async roleProblems(): Promise<RoleProblem[]> {
    return findRoleProblems((sql) => this.prisma.$queryRawUnsafe(sql));
  }
}
