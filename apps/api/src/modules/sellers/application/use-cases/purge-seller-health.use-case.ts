import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerHealthStore } from '../ports/seller-health.store';

/**
 * Local dates older than this many days are deleted. It is above the longest window a Market may
 * set (366 days) plus the three-day recount, so no score ever reads a deleted day. The cut is made
 * on the UTC date: a seller's local date differs from it by at most a day, which the margin covers.
 */
export const SELLER_HEALTH_KEPT_DAYS = 400;

export type PurgeSellerHealthFailure = { readonly code: 'access.denied' };

export interface PurgeSellerHealthOutput {
  readonly days: number;
  readonly snapshots: number;
}

export interface PurgeSellerHealthDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly healthStore: SellerHealthStore;
  readonly clock: Clock;
}

/**
 * `sellers.purge-seller-health` (seller health retention): for one Market, deletes the daily
 * counters and snapshots older than {@link SELLER_HEALTH_KEPT_DAYS}. It deletes only what no
 * window can read any more, so it is safe to run twice and concurrently. Rule `system`: run by
 * its job only.
 */
export class PurgeSellerHealth extends UseCase<
  Record<string, never>,
  PurgeSellerHealthOutput,
  PurgeSellerHealthFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.purge-seller-health',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PurgeSellerHealthDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PurgeSellerHealthOutput, PurgeSellerHealthFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, healthStore, clock } = this.deps;
    const before = clock
      .now()
      .toZonedDateTimeISO('UTC')
      .toPlainDate()
      .subtract({ days: SELLER_HEALTH_KEPT_DAYS });
    // A failed unit throws out of here: the scheduler logs that Market's run as failed.
    const purged = await unitOfWork.run(market, async () =>
      ok(await healthStore.purgeBefore(market, before)),
    );
    if (!purged.ok) throw new Error('sellers.purge-seller-health: the unit failed');
    return ok(purged.value);
  }
}
