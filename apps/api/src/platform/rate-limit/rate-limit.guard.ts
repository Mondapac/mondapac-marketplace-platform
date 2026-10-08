import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { MarketRegistry } from '../market-config/market-registry';
import { isMarketContextExempt } from '../market-context/market-context.guard';
import { marketContextOf } from '../market-context/market.decorator';
import { clientAddressFrom } from '../http/client-address';
import { clientOriginOf } from './client-origin';
import { RATE_LIMIT_CLASS, RATE_LIMIT_CLASSES, type RateLimitClass } from './rate-limit.decorator';

/** The fixed window of every limit (identity design 6.8, M11: fixed windows). */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** The answer to a throttled request (identity design 5.2): 429, a code, never library text. */
export const THROTTLED_CODE = 'request.throttled';
/** The answer when the limiter cannot be evaluated: fail closed (identity design 5.2). */
export const UNAVAILABLE_CODE = 'access.unavailable';

/**
 * The generic per-origin rate limiter (identity design 6.8 and 12.2, ADR-0015 decision 3; the
 * package `rate-limiter-flexible`, owner-approved 2026-10-07). A global guard, second in
 * `GLOBAL_GUARDS`: after `MarketContextGuard`, whose refusals read nothing, and before the
 * actor guard and every controller, so no `identity` code runs for a throttled request
 * (identity design 6.3 step 1).
 *
 * - **Key:** the resolved client address (`platform/http/client-address.ts`, ADR-0037: the
 *   socket's, or the one a BFF proved), as the IPv4 address or the IPv6 /64
 *   ({@link clientOriginOf}). Forwarded headers are never read.
 * - **Counters:** in this process's memory, one per limit class and origin, not split by Market
 *   (PF I11): the limiter is the cross-Market control. One API process may count in memory; a
 *   second instance needs the package's PostgreSQL store (identity design 13).
 * - **Limits:** the request Market's `requestLimits` (Market configuration); the class comes
 *   from `@RateLimit()`, `default` otherwise. Fixed windows of 60 seconds.
 * - **Answers:** over the limit, 429 `{ statusCode, code: 'request.throttled', details: {
 *   retryAfterSeconds } }` and `Retry-After`; an origin or a counter that cannot be evaluated,
 *   503 `access.unavailable` (fail closed). Never the library's text.
 * - **Exempt:** a controller exempt from the Market (`/health` only) has no Market, so no limit
 *   applies to it; it reaches no module code.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  readonly #logger = new Logger('RateLimitGuard');
  readonly #counters: Readonly<Record<RateLimitClass, RateLimiterMemory>>;

  constructor(
    private readonly reflector: Reflector,
    private readonly markets: MarketRegistry,
  ) {
    const counters = {} as Record<RateLimitClass, RateLimiterMemory>;
    for (const limitClass of RATE_LIMIT_CLASSES) {
      // The library never refuses (the limit is the Market's, compared below), so one counter
      // serves every Market: `points` is only the ceiling of the count it keeps.
      counters[limitClass] = new RateLimiterMemory({
        keyPrefix: limitClass,
        points: Number.MAX_SAFE_INTEGER,
        duration: RATE_LIMIT_WINDOW_SECONDS,
      });
    }
    this.#counters = Object.freeze(counters);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      throw new Error('RateLimitGuard limits HTTP requests only');
    }
    if (isMarketContextExempt(context.getClass())) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<IncomingMessage & { id?: unknown }>();
    const limitClass =
      this.reflector.getAllAndOverride(RATE_LIMIT_CLASS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'default';

    let retryAfterSeconds: number | null;
    try {
      const market = marketContextOf(request);
      const limits = this.markets.get(market.marketId).requestLimits;
      const limit =
        limitClass === 'anonymous-identity'
          ? limits.anonymousIdentityPerMinute
          : limits.defaultPerMinute;
      const origin = clientOriginOf(clientAddressFrom(request));
      if (origin === null) throw new Error('no client origin');
      const counted = await this.#counters[limitClass].consume(origin);
      retryAfterSeconds =
        counted.consumedPoints > limit ? Math.max(1, Math.ceil(counted.msBeforeNext / 1000)) : null;
    } catch {
      // Fail closed: nothing behind the limiter runs when it cannot decide.
      this.log('rate-limit.unavailable', request, limitClass);
      throw new HttpException({ statusCode: 503, code: UNAVAILABLE_CODE }, 503);
    }

    if (retryAfterSeconds === null) return true;
    this.log(THROTTLED_CODE, request, limitClass);
    http.getResponse<ServerResponse>().setHeader('Retry-After', String(retryAfterSeconds));
    throw new HttpException(
      { statusCode: 429, code: THROTTLED_CODE, details: { retryAfterSeconds } },
      429,
    );
  }

  /** The limit class and the correlation id; never the address (personal data) or a count. */
  private log(msg: string, request: { id?: unknown }, limitClass: RateLimitClass): void {
    this.#logger.warn({ msg, limitClass, correlationId: request.id ?? null });
  }
}
