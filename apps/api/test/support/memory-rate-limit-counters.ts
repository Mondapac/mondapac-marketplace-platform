import { RateLimiterMemory } from 'rate-limiter-flexible';
import {
  RATE_LIMIT_CLASSES,
  type RateLimitClass,
} from '../../src/platform/rate-limit/rate-limit.decorator';
import {
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitCount,
  type RateLimitCounters,
} from '../../src/platform/rate-limit/rate-limit-counters';

/**
 * The counters of one process, in memory: what `createTestApp` puts in place of the PostgreSQL
 * store, so a suite without a database runs the real guard with the same fixed windows. A fresh
 * instance per application, so each test application starts with empty counters.
 */
export class MemoryRateLimitCounters implements RateLimitCounters {
  readonly #limiters: Readonly<Record<RateLimitClass, RateLimiterMemory>>;

  constructor() {
    const limiters = {} as Record<RateLimitClass, RateLimiterMemory>;
    for (const limitClass of RATE_LIMIT_CLASSES) {
      limiters[limitClass] = new RateLimiterMemory({
        keyPrefix: limitClass,
        points: Number.MAX_SAFE_INTEGER,
        duration: RATE_LIMIT_WINDOW_SECONDS,
      });
    }
    this.#limiters = Object.freeze(limiters);
  }

  async consume(limitClass: RateLimitClass, originKey: string): Promise<RateLimitCount> {
    const counted = await this.#limiters[limitClass].consume(originKey);
    return { count: counted.consumedPoints, msBeforeNext: counted.msBeforeNext };
  }
}
