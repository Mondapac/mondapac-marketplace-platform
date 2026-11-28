import { Global, Logger, Module } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { CLOCK } from '../clock/clock.module';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import {
  POSTGRES_RATE_LIMIT_COUNTERS,
  RATE_LIMIT_COUNTERS,
  type RateLimitCounters,
} from './rate-limit-counters';
import { RateLimitRedis } from './rate-limit-redis';
import { RATE_LIMIT_KEY_PREFIX, RedisRateLimitCounters } from './redis-rate-limit-counters';
import { RoutedRateLimitCounters } from './routed-rate-limit-counters';

/** Nest token of the Redis client of the counters, or null without Redis. */
export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');
/**
 * Nest token of the Redis key prefix (`rl`). A test replaces it with a prefix of its own worker,
 * `rl:test-<worker>`, so parallel suites never share a window (Kazem on the design).
 */
export const RATE_LIMIT_REDIS_KEY_PREFIX = Symbol('RATE_LIMIT_REDIS_KEY_PREFIX');

/**
 * Where the rate-limit counters live (ADR-0054): binds {@link RATE_LIMIT_COUNTERS} to the routed
 * counters, the Redis classes to Redis when `config.rateLimitStore` says so, every other class
 * to the PostgreSQL counters of `PersistenceModule`. Global, like the other platform runtime
 * modules; it exports the counters' token only, so no module can reach the Redis client.
 */
@Global()
@Module({
  providers: [
    {
      provide: RATE_LIMIT_REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): RateLimitRedis | null =>
        config.rateLimitStore.store === 'redis'
          ? new RateLimitRedis(config.rateLimitStore.redis)
          : null,
    },
    { provide: RATE_LIMIT_REDIS_KEY_PREFIX, useValue: RATE_LIMIT_KEY_PREFIX },
    {
      provide: RATE_LIMIT_COUNTERS,
      inject: [RATE_LIMIT_REDIS, POSTGRES_RATE_LIMIT_COUNTERS, CLOCK, RATE_LIMIT_REDIS_KEY_PREFIX],
      useFactory: (
        redis: RateLimitRedis | null,
        postgres: RateLimitCounters,
        clock: Clock,
        keyPrefix: string,
      ): RateLimitCounters => {
        const logger = new Logger('RateLimitCounters');
        if (redis === null) {
          // BUG-019: without Redis every class shares one PostgreSQL row per origin, so parallel
          // reads of one browser wait on its lock, hold pooled connections and answer 503.
          logger.warn({
            msg: 'rate-limit.store',
            store: 'postgres',
            hint: 'Every rate-limit class is counted in PostgreSQL. Set REDIS_URL (docker compose starts Redis) unless RATE_LIMIT_STORE=postgres is the rollback switch on purpose.',
          });
        } else {
          logger.log({ msg: 'rate-limit.store', store: 'redis' });
        }
        return new RoutedRateLimitCounters(
          redis === null ? null : new RedisRateLimitCounters(redis, clock, keyPrefix),
          postgres,
        );
      },
    },
  ],
  exports: [RATE_LIMIT_COUNTERS],
})
export class RateLimitStoreModule {}
