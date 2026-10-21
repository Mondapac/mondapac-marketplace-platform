import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { GUEST_CREATE_ORIGIN } from '../../domain/rate-limits';
import type { CartPolicy } from '../ports/cart-policy';
import type { CartRepository } from '../ports/cart.repository';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SavedItemRepository } from '../ports/saved-item.repository';
import { SAVED_ITEM_RETENTION_DAYS } from '../saved-operations';

/** Carts deleted per unit (cart design 12: at most 10,000 lines under the 50-line limit). */
export const PURGE_BATCH_SIZE = 200;
/** Units per run; the next hour continues. */
export const MAX_PURGE_BATCHES_PER_RUN = 20;
/** A counter is kept this many minutes after its window started: the longest window is 60. */
export const RATE_COUNTER_RETENTION_MINUTES = GUEST_CREATE_ORIGIN.windowMinutes;

export type PurgeFailure =
  { readonly code: 'access.denied' } | { readonly code: 'cart.purge-failed' };

export interface PurgeInactiveCartsOutput {
  readonly carts: number;
  readonly rateCounters: number;
  readonly savedItems: number;
}

export interface PurgeInactiveCartsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly carts: CartRepository;
  readonly counters: RateCounterRepository;
  readonly saved: SavedItemRepository;
  readonly policy: CartPolicy;
  readonly clock: Clock;
}

/**
 * `cart.purge-inactive-carts`, run by the hourly job `cart.purge-inactive` (cart design 11, 12): deletes guest and MERGED carts 7 days after
 * their last change and account carts 90 days after (their lines go by the cascade), in batches of
 * 200 ordered by `last_changed_at`, one unit per batch; the saved-for-later items last saved a
 * year ago or more, in the same batches; and the rate counters whose window ended.
 * Rule `system`, one call per hosted Market; safe to run twice and concurrently (each delete
 * repeats the expiry condition). Correctness never depends on it: an expired guest cart is
 * ignored at read time.
 */
export class PurgeInactiveCarts extends UseCase<
  Record<string, never>,
  PurgeInactiveCartsOutput,
  PurgeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.purge-inactive-carts',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('PurgeInactiveCarts');

  constructor(
    gate: UseCaseGate,
    private readonly deps: PurgeInactiveCartsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PurgeInactiveCartsOutput, PurgeFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, carts, counters, saved, policy, clock } = this.deps;
    const now = clock.now();
    const guestBefore = now.subtract({ milliseconds: policy.guestTtlMs() });
    const accountBefore = now.subtract({ milliseconds: policy.accountRetentionMs() });
    let purged = 0;
    let failed = false;
    try {
      for (let batch = 0; batch < MAX_PURGE_BATCHES_PER_RUN; batch += 1) {
        const done = await unitOfWork.run(market, async () =>
          ok(await carts.purgeInactive(market, guestBefore, accountBefore, PURGE_BATCH_SIZE)),
        );
        if (!done.ok) {
          failed = true;
          break;
        }
        purged += done.value;
        if (done.value < PURGE_BATCH_SIZE) break;
      }
    } catch {
      failed = true;
    }
    let savedItems = 0;
    const savedBefore = now.subtract({ hours: SAVED_ITEM_RETENTION_DAYS * 24 });
    try {
      for (let batch = 0; batch < MAX_PURGE_BATCHES_PER_RUN && !failed; batch += 1) {
        const done = await unitOfWork.run(market, async () =>
          ok(await saved.purgeSavedBefore(market, savedBefore, PURGE_BATCH_SIZE)),
        );
        if (!done.ok) {
          failed = true;
          break;
        }
        savedItems += done.value;
        if (done.value < PURGE_BATCH_SIZE) break;
      }
    } catch {
      failed = true;
    }
    let pruned = 0;
    try {
      const counted = await unitOfWork.run(market, async () =>
        ok(
          await counters.purgeStartedBefore(
            market,
            now.subtract({ minutes: RATE_COUNTER_RETENTION_MINUTES }),
          ),
        ),
      );
      if (counted.ok) pruned = counted.value;
      else failed = true;
    } catch {
      failed = true;
    }
    // A failed batch or prune is never reported as a success: the job throws, so it is visible.
    if (failed) {
      this.#logger.warn({
        msg: 'cart.purge-inactive.failed',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'cart.purge-failed' });
    }
    return ok({ carts: purged, rateCounters: pruned, savedItems });
  }
}
