import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { GUEST_CREATE_ORIGIN } from '../../domain/rate-limits';
import type { CartPolicy } from '../ports/cart-policy';
import type { CartRepository } from '../ports/cart.repository';
import type { RateCounterRepository } from '../ports/rate-counter.repository';

/** Carts deleted per unit (cart design 12: at most 10,000 lines under the 50-line limit). */
export const PURGE_BATCH_SIZE = 200;
/** Units per run; the next hour continues. */
export const MAX_PURGE_BATCHES_PER_RUN = 20;
/** A counter is kept this many minutes after its window started: the longest window is 60. */
export const RATE_COUNTER_RETENTION_MINUTES = GUEST_CREATE_ORIGIN.windowMinutes;

export interface PurgeInactiveCartsOutput {
  readonly carts: number;
  readonly rateCounters: number;
}

export interface PurgeInactiveCartsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly carts: CartRepository;
  readonly counters: RateCounterRepository;
  readonly policy: CartPolicy;
  readonly clock: Clock;
}

/**
 * `cart.purge-inactive-carts`, run by the hourly job `cart.purge-inactive` (cart design 11, 12): deletes guest and MERGED carts 7 days after
 * their last change and account carts 90 days after (their lines go by the cascade), in batches of
 * 200 ordered by `last_changed_at`, one unit per batch; and the rate counters whose window ended.
 * Rule `system`, one call per hosted Market; safe to run twice and concurrently (each delete
 * repeats the expiry condition). Correctness never depends on it: an expired guest cart is
 * ignored at read time.
 */
export class PurgeInactiveCarts extends UseCase<
  Record<string, never>,
  PurgeInactiveCartsOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.purge-inactive-carts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PurgeInactiveCartsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PurgeInactiveCartsOutput, { readonly code: 'access.denied' }>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, carts, counters, policy, clock } = this.deps;
    const now = clock.now();
    const guestBefore = now.subtract({ milliseconds: policy.guestTtlMs() });
    const accountBefore = now.subtract({ milliseconds: policy.accountRetentionMs() });
    let purged = 0;
    for (let batch = 0; batch < MAX_PURGE_BATCHES_PER_RUN; batch += 1) {
      const done = await unitOfWork.run(market, async () =>
        ok(await carts.purgeInactive(market, guestBefore, accountBefore, PURGE_BATCH_SIZE)),
      );
      if (!done.ok) break;
      purged += done.value;
      if (done.value < PURGE_BATCH_SIZE) break;
    }
    const pruned = await unitOfWork.run(market, async () =>
      ok(
        await counters.purgeStartedBefore(
          market,
          now.subtract({ minutes: RATE_COUNTER_RETENTION_MINUTES }),
        ),
      ),
    );
    return ok({ carts: purged, rateCounters: pruned.ok ? pruned.value : 0 });
  }
}
