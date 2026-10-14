import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { PRICE_WRITE_LIMITS, writeRateVerdict } from '../domain/write-rate-limits';
import type { WriteRateCounterRepository } from './ports/write-rate-counter.repository';

export interface WriteAllowanceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly counters: WriteRateCounterRepository;
  readonly clock: Clock;
}

/** The refusal of a seller account past its price-write cap. */
export type WriteThrottled = {
  readonly code: 'request.throttled';
  readonly retryAfterSeconds: number;
};

/**
 * The per-account cap on price writes: counts one attempt of the seller account in a unit of its
 * own, before the Offer lookup and the write unit (the count must commit even when the write is
 * refused, so scanning other sellers' Offers is limited too). The verdict is read outside the
 * unit, so a refused attempt keeps its count.
 */
export async function reserveWriteAllowance(
  deps: WriteAllowanceDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<true, WriteThrottled>> {
  const { market } = context;
  const now = deps.clock.now();
  const reserved = await deps.unitOfWork.run(market, async () =>
    ok(await deps.counters.reserve(market, accountId, PRICE_WRITE_LIMITS, now)),
  );
  // A failed unit throws out of here, so a store fault is never a pass.
  if (!reserved.ok) throw new Error('pricing write allowance: the counter unit failed');
  const verdict = writeRateVerdict(PRICE_WRITE_LIMITS, reserved.value, now);
  return verdict.allowed
    ? ok(true)
    : err({ code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds });
}
