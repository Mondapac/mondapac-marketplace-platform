import type { CountedClass, RateLimitCount, RateLimitCounters } from './rate-limit-counters';

/**
 * The store of every counted class (ADR-0054 decision 1). A complete, typed map, so a new class
 * does not compile until it names its store (Mohammad on the design).
 *
 * - `redis`: the high-traffic per-origin classes. Their counts may restart early after a Redis
 *   restart, failover or eviction, and while Redis is unreachable each API instance counts them
 *   in its own memory (ADR-0054 decision 3).
 * - `postgres`: the low-traffic, sensitive classes. `anonymous-identity` protects sign-in,
 *   sign-up, resets and mail (Hassan: must stay); the per-subject classes guard payments, the
 *   assistant and admin actions. They must survive restarts and they fail closed.
 */
export const RATE_LIMIT_STORE_OF = Object.freeze({
  default: 'redis',
  'public-search': 'redis',
  'public-media': 'redis',
  'anonymous-identity': 'postgres',
  'checkout-payment': 'postgres',
  'assistant-message': 'postgres',
  'admin-customer-password-reset': 'postgres',
  'admin-customer-pii-reveal': 'postgres',
} as const satisfies Record<CountedClass, 'redis' | 'postgres'>);

/** The classes counted in Redis. */
export type RedisCountedClass = {
  [K in CountedClass]: (typeof RATE_LIMIT_STORE_OF)[K] extends 'redis' ? K : never;
}[CountedClass];

/** The classes counted in Redis, as a list. */
export const REDIS_COUNTED_CLASSES = Object.freeze(
  (Object.keys(RATE_LIMIT_STORE_OF) as CountedClass[]).filter(
    (counted): counted is RedisCountedClass => RATE_LIMIT_STORE_OF[counted] === 'redis',
  ),
);

/** The counters of the Redis classes ({@link RedisRateLimitCounters}). */
export interface RedisClassCounters {
  consume(limitClass: RedisCountedClass, key: string): Promise<RateLimitCount>;
}

/**
 * The {@link RateLimitCounters} of the API (ADR-0054): each class goes to its store by
 * {@link RATE_LIMIT_STORE_OF}. Without Redis (`RATE_LIMIT_STORE=postgres`, the rollback switch,
 * or a local run without `REDIS_URL`) every class is counted in PostgreSQL, as before ADR-0054.
 */
export class RoutedRateLimitCounters implements RateLimitCounters {
  constructor(
    private readonly redis: RedisClassCounters | null,
    private readonly postgres: RateLimitCounters,
  ) {}

  async consume(limitClass: CountedClass, key: string): Promise<RateLimitCount> {
    if (this.redis !== null && isRedisClass(limitClass)) {
      return await this.redis.consume(limitClass, key);
    }
    return await this.postgres.consume(limitClass, key);
  }
}

function isRedisClass(counted: CountedClass): counted is RedisCountedClass {
  return RATE_LIMIT_STORE_OF[counted] === 'redis';
}
