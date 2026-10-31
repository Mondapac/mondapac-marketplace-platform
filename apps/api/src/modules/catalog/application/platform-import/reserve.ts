import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { rateVerdict, type RateLimit } from '../../domain/rate-limits';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';

export interface ReserveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

export type ReserveFailure =
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' };

const logger = new Logger('PlatformImportLimits');

/**
 * Counts one attempt against per-account limits (catalog data design 3.26), in a reservation unit
 * of its own before any work: a throttled admin costs the parser nothing. A store that cannot
 * answer is `access.unavailable`, never a pass.
 */
export async function reserveForAccount(
  deps: ReserveDependencies,
  context: CallContext,
  limits: readonly RateLimit[],
  accountId: Id<'Account'>,
): Promise<ReserveFailure | null> {
  const { market } = context;
  try {
    const counters = limits.map((limit) => ({
      limit,
      keyHash: deps.counterKeys.keyOf(market, limit.kind, accountId),
    }));
    const now = deps.clock.now();
    const reserved = await deps.unitOfWork.run(market, async () =>
      ok(await deps.counters.reserve(market, counters, now)),
    );
    if (!reserved.ok) return { code: 'access.unavailable' };
    const verdict = rateVerdict(limits, reserved.value, now);
    if (verdict.allowed) return null;
    logger.warn({
      msg: 'catalog.request-throttled',
      kinds: limits.map((limit) => limit.kind),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds };
  } catch {
    logger.error({
      msg: 'catalog.rate-counters-unavailable',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return { code: 'access.unavailable' };
  }
}
