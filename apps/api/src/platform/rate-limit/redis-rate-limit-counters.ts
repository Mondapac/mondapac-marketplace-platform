import { Logger } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { windowSecondsOf, type RateLimitCount } from './rate-limit-counters';
import { redisErrorCode, type RateLimitRedis } from './rate-limit-redis';
import {
  REDIS_COUNTED_CLASSES,
  type RedisClassCounters,
  type RedisCountedClass,
} from './routed-rate-limit-counters';

/** The prefix of every rate-limit key in Redis: `rl:<class>:<64 hex>` (the ACL allows `~rl:*`). */
export const RATE_LIMIT_KEY_PREFIX = 'rl';

/** Consecutive failed commands that open the circuit (ADR-0054 decision 3). */
export const BREAKER_FAILURES_TO_OPEN = 3;
/** How long an open circuit counts in memory before it tries Redis again. */
export const BREAKER_OPEN_MS = 5000;
/** At most one store-state log line per this many milliseconds. */
export const STORE_LOG_EVERY_MS = 30_000;

/** The store-state lines (ADR-0054 decision 4): class and a fixed code only. */
export const STORE_DEGRADED = 'rate-limit.store-degraded';
export const STORE_RECOVERED = 'rate-limit.store-recovered';

/** What this process counted since it started; the fallback count is the degraded metric. */
export interface RedisCounterStats {
  readonly state: 'redis' | 'memory';
  readonly fallbackRequests: number;
}

/**
 * The Redis classes ({@link RedisCountedClass}) on the Redis store of `rate-limiter-flexible`
 * (ADR-0054; the same owner-approved package, pinned 11.2.1): one atomic Lua script per request
 * (`SET NX EX`, `INCRBY`, `PTTL`), no row lock, the key expiring with its window, so nothing has
 * to be purged. The key is `rl:<class>:<the origin's keyed hash>`, never an address.
 *
 * When Redis cannot count (down, slow past 200 ms, refusing), the request is counted in this
 * process's memory instead of failing closed (ADR-0054 decision 3: for these three classes the
 * real limit can rise to "limit x instances" during an outage). A short circuit breaker keeps a
 * failing Redis from adding 200 ms to every request and keeps counts from alternating between
 * the stores: after {@link BREAKER_FAILURES_TO_OPEN} failures in a row every request goes to
 * memory for {@link BREAKER_OPEN_MS}, then one request tries Redis again.
 *
 * The package's own `insuranceLimiter` is not used: it hides the failure from this class, which
 * then could not run the breaker or log the change of state. The behaviour is the same, an
 * in-memory `RateLimiterMemory` per class. `inMemoryBlockOnConsumed` is not used either: the
 * counters never refuse (`points` is the safe-integer ceiling; the guard compares with the
 * Market's limit), so it would never fire.
 */
export class RedisRateLimitCounters implements RedisClassCounters {
  readonly #logger = new Logger('RateLimitCounters');
  readonly #redis: Readonly<Record<RedisCountedClass, RateLimiterRedis>>;
  readonly #memory: Readonly<Record<RedisCountedClass, RateLimiterMemory>>;
  #failures = 0;
  #openUntil = 0;
  #reportedDegraded = false;
  #lastLogAt = Number.NEGATIVE_INFINITY;
  #fallbackRequests = 0;
  #episodeFallbacks = 0;

  constructor(
    private readonly connection: Pick<RateLimitRedis, 'client' | 'firstConnection'>,
    private readonly clock: Clock,
    keyPrefix: string = RATE_LIMIT_KEY_PREFIX,
  ) {
    const redis = {} as Record<RedisCountedClass, RateLimiterRedis>;
    const memory = {} as Record<RedisCountedClass, RateLimiterMemory>;
    for (const limitClass of REDIS_COUNTED_CLASSES) {
      // The library never refuses (the limit is the Market's, compared by the guard), so one
      // counter serves every Market: `points` is only the ceiling of the count it keeps.
      redis[limitClass] = new RateLimiterRedis({
        storeClient: connection.client,
        rejectIfRedisNotReady: true,
        keyPrefix: `${keyPrefix}:${limitClass}`,
        points: Number.MAX_SAFE_INTEGER,
        duration: windowSecondsOf(limitClass),
      });
      memory[limitClass] = new RateLimiterMemory({
        keyPrefix: `${keyPrefix}:${limitClass}`,
        points: Number.MAX_SAFE_INTEGER,
        duration: windowSecondsOf(limitClass),
      });
    }
    this.#redis = Object.freeze(redis);
    this.#memory = Object.freeze(memory);
  }

  async consume(limitClass: RedisCountedClass, key: string): Promise<RateLimitCount> {
    if (this.#now() >= this.#openUntil) {
      try {
        await this.connection.firstConnection();
        const counted = await this.#redis[limitClass].consume(key);
        this.#succeeded();
        return { count: counted.consumedPoints, msBeforeNext: counted.msBeforeNext };
      } catch (error) {
        this.#failed(limitClass, error);
      }
    }
    this.#fallbackRequests += 1;
    this.#episodeFallbacks += 1;
    const counted = await this.#memory[limitClass].consume(key);
    return { count: counted.consumedPoints, msBeforeNext: counted.msBeforeNext };
  }

  stats(): RedisCounterStats {
    return {
      state: this.#failures >= BREAKER_FAILURES_TO_OPEN ? 'memory' : 'redis',
      fallbackRequests: this.#fallbackRequests,
    };
  }

  #succeeded(): void {
    const wasDegraded = this.#failures >= BREAKER_FAILURES_TO_OPEN;
    this.#failures = 0;
    this.#openUntil = 0;
    if (wasDegraded && this.#reportedDegraded) {
      this.#reportedDegraded = false;
      this.#lastLogAt = this.#now();
      this.#logger.log({
        msg: STORE_RECOVERED,
        store: 'redis',
        fallbackRequests: this.#episodeFallbacks,
      });
    }
    if (wasDegraded) this.#episodeFallbacks = 0;
  }

  #failed(limitClass: RedisCountedClass, error: unknown): void {
    this.#failures += 1;
    if (this.#failures < BREAKER_FAILURES_TO_OPEN) return;
    const now = this.#now();
    this.#openUntil = now + BREAKER_OPEN_MS;
    if (!this.#reportedDegraded && now - this.#lastLogAt >= STORE_LOG_EVERY_MS) {
      this.#reportedDegraded = true;
      this.#lastLogAt = now;
      // Class and a fixed code only: never the key, the hash, the host or the client's text.
      this.#logger.warn({
        msg: STORE_DEGRADED,
        store: 'redis',
        fallback: 'memory',
        limitClass,
        errorCode: redisErrorCode(error),
      });
    }
  }

  #now(): number {
    return this.clock.now().epochMilliseconds;
  }
}
