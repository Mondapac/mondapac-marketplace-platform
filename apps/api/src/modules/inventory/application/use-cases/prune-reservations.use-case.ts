import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { ReservationRepository } from '../ports/reservation.repository';

/** RELEASED and EXPIRED reservations are kept this long after their last status change (design 11). */
export const PRUNE_RETENTION_DAYS = 30;
/** Rate counters are kept this long after their window started. */
export const RATE_COUNTER_RETENTION_HOURS = 48;
/** Reservations deleted per unit, and units per run; the next hour continues. */
export const PRUNE_BATCH_SIZE = 500;
export const MAX_PRUNE_BATCHES_PER_RUN = 20;

export interface PruneReservationsOutput {
  readonly reservations: number;
  readonly rateCounters: number;
}

export interface PruneReservationsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reservations: ReservationRepository;
  readonly counters: RateCounterRepository;
  readonly clock: Clock;
}

/**
 * `inventory.prune-reservations`, hourly (inventory design 11): deletes RELEASED and EXPIRED
 * reservations 30 days after their last status change (their lines go by the cascade) and the
 * `reserve` rate counters 48 hours after their window started. It takes no stock lock: no sum
 * reads these rows (M7, design 4.3). COMMITTED reservations are never pruned here. Rule `system`,
 * one call per hosted Market; safe to run twice and concurrently (each delete re-checks status).
 */
export class PruneReservations extends UseCase<
  Record<string, never>,
  PruneReservationsOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.prune-reservations',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PruneReservationsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PruneReservationsOutput, { readonly code: 'access.denied' }>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, reservations, counters, clock } = this.deps;
    const now = clock.now();
    const before = now.subtract({ hours: PRUNE_RETENTION_DAYS * 24 });
    let pruned = 0;
    for (let batch = 0; batch < MAX_PRUNE_BATCHES_PER_RUN; batch += 1) {
      const done = await unitOfWork.run(market, async () =>
        ok(await reservations.pruneTerminal(market, before, PRUNE_BATCH_SIZE)),
      );
      if (!done.ok) break;
      pruned += done.value;
      if (done.value < PRUNE_BATCH_SIZE) break;
    }
    const purged = await unitOfWork.run(market, async () =>
      ok(
        await counters.purgeStartedBefore(
          market,
          now.subtract({ hours: RATE_COUNTER_RETENTION_HOURS }),
        ),
      ),
    );
    return ok({ reservations: pruned, rateCounters: purged.ok ? purged.value : 0 });
  }
}
