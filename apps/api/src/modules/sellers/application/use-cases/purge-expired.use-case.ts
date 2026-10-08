import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { RateCounterRepository } from '../ports/rate-counter.repository';

/** Counters whose window started more than 48 hours ago go (data design 3.11, 10.4). */
export const RATE_COUNTERS_KEPT_HOURS = 48;

export interface PurgeExpiredOutput {
  readonly rateCounters: number;
}

export type PurgeExpiredFailure = { readonly code: 'access.denied' };

export interface PurgeExpiredDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly counters: RateCounterRepository;
  readonly clock: Clock;
}

/**
 * `sellers.purge-expired` (sellers data design 3.11, 11; Q-M7): for one Market, deletes the
 * quota counters whose window started more than 48 hours ago (the longest window is 24 hours,
 * so they can no longer count). It deletes only what is already invalid, so it is safe to run
 * twice and concurrently. Rule `system`: run by the hourly job only. The purge of abandoned
 * files is another job (`sellers.purge-abandoned-files`, slice 18).
 */
export class PurgeExpired extends UseCase<
  Record<string, never>,
  PurgeExpiredOutput,
  PurgeExpiredFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.purge-expired',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PurgeExpiredDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PurgeExpiredOutput, PurgeExpiredFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, counters, clock } = this.deps;
    const before = clock.now().subtract({ hours: RATE_COUNTERS_KEPT_HOURS });
    // A failed unit throws out of here: the scheduler logs that Market's run as failed.
    const purged = await unitOfWork.run(market, async () =>
      ok(await counters.purgeStartedBefore(market, before)),
    );
    if (!purged.ok) throw new Error('sellers.purge-expired: the unit failed');
    return ok({ rateCounters: purged.value });
  }
}
