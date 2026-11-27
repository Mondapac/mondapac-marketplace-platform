import type { OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';
import { PrismaClient, type Prisma } from '../../generated/prisma/client';
import type { AppConfig } from '../config/app-config';
import { CONNECTION_WAIT_MS } from '../unit-of-work/unit-of-work';

/** How long an idle pooled connection is kept (Kazem, spike 6 decision 2). */
export const POOL_IDLE_TIMEOUT_MS = 30_000;

/**
 * The pool of the process (platform persistence design 3.1 row 8; Hassan's spike 6 review):
 * at most 2 s to obtain a connection for every statement, so pool exhaustion fails fast in a
 * read-only unit too, and an explicit maximum (`DATABASE_POOL_MAX`). No statement name
 * generator: the application never uses named prepared statements (data platform.md 10.9).
 * `connectionWaitMs` is for the database test harness alone; the application keeps 2 s.
 */
export function poolConfigOf(
  config: AppConfig,
  connectionWaitMs: number = CONNECTION_WAIT_MS,
): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: connectionWaitMs,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  };
}

/** Client options a test may add (query events, a longer connection wait); never the adapter. */
export type PrismaRootOptions = Omit<Prisma.PrismaClientOptions, 'adapter' | 'accelerateUrl'> & {
  readonly connectionWaitMs?: number;
};

/**
 * The base client, without the market guard (P 3.3). Visible inside `platform/persistence/`
 * only: `PersistenceModule` does not export it, and dependency-cruiser keeps module code to
 * `prisma.service.ts`. Its users are the guarded client built on it, `DatabaseProbe`, and
 * later the relay and the scheduler lock, each in short transactions of their own.
 */
export class PrismaRoot extends PrismaClient implements OnApplicationShutdown {
  /** The pool's connection wait, also the `maxWait` of the root's own transactions. */
  readonly connectionWaitMs: number;

  constructor(
    config: AppConfig,
    { connectionWaitMs = CONNECTION_WAIT_MS, ...options }: PrismaRootOptions = {},
  ) {
    super({ ...options, adapter: new PrismaPg(poolConfigOf(config, connectionWaitMs)) });
    this.connectionWaitMs = connectionWaitMs;
  }

  /**
   * The pool closes last, after every `onModuleDestroy` and `beforeApplicationShutdown`, so work
   * still out when the application closes (the AI Gateway's shadow calls, G6c) settles its rows
   * first (Mohammad, G6c review 2).
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
