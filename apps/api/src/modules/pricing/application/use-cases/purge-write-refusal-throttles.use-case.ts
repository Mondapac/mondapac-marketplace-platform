import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { WriteRefusalThrottleRepository } from '../ports/write-refusal-throttle.repository';

/** Counters whose window started more than an hour ago go (pricing-data 3.8, 9). */
export const REFUSAL_COUNTERS_KEPT_MS = 3_600_000;

export interface PurgeWriteRefusalThrottlesOutput {
  readonly actorWindows: number;
  readonly offerWindows: number;
}

export type PurgeWriteRefusalThrottlesFailure = { readonly code: 'access.denied' };

export interface PurgeWriteRefusalThrottlesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly throttles: WriteRefusalThrottleRepository;
  readonly clock: Clock;
}

/**
 * `pricing.purge-write-refusal-throttles` (pricing-data 3.8, 9; design 19 condition (b): it
 * ships with the first caller). For one Market, deletes the refusal counters whose window
 * started more than an hour ago; a window is one minute, so they can no longer count. Rule
 * `system`: run by the hourly job only. Safe to run twice and concurrently.
 *
 * Lock order (design 19 (b) and (e), settled in part 3b): a refusal takes the actor row, then
 * the (actor, Offer) row. The purge never holds rows of both tables at once: the actor table is
 * purged in its own unit, then the (actor, Offer) table in another, so it can never close a
 * wait cycle with a refusal unit.
 */
export class PurgeWriteRefusalThrottles extends UseCase<
  Record<string, never>,
  PurgeWriteRefusalThrottlesOutput,
  PurgeWriteRefusalThrottlesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.purge-write-refusal-throttles',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PurgeWriteRefusalThrottlesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PurgeWriteRefusalThrottlesOutput, PurgeWriteRefusalThrottlesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, throttles, clock } = this.deps;
    const before = clock.now().subtract({ milliseconds: REFUSAL_COUNTERS_KEPT_MS });
    // A failed unit throws out of here: the scheduler logs that Market's run as failed.
    const actors = await unitOfWork.run(market, async () =>
      ok(await throttles.purgeActorWindowsStartedBefore(market, before)),
    );
    if (!actors.ok) throw new Error('pricing.purge-write-refusal-throttles: the unit failed');
    const offers = await unitOfWork.run(market, async () =>
      ok(await throttles.purgeOfferWindowsStartedBefore(market, before)),
    );
    if (!offers.ok) throw new Error('pricing.purge-write-refusal-throttles: the unit failed');
    return ok({ actorWindows: actors.value, offerWindows: offers.value });
  }
}
