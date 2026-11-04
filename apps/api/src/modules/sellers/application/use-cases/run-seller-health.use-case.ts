import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { err } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { countSellerHealthDays, storeSellerHealth } from '../health/rollup-seller-health';
import type { SellerHealthPolicy } from '../ports/seller-health-policy';
import type { SellerHealthRoster } from '../ports/seller-health-roster';
import type { SellerHealthSignals } from '../ports/seller-health-signals';
import type { SellerHealthStore } from '../ports/seller-health.store';

/** Sellers per page of the roster, and between two pauses. */
export const SELLER_HEALTH_BATCH = 25;
/** The pause between two batches, so the nightly run never holds the database busy. */
export const SELLER_HEALTH_PAUSE_MS = 250;

export type RunSellerHealthFailure = { readonly code: 'access.denied' };

export interface RunSellerHealthOutput {
  /** Sellers measured this run. */
  readonly measured: number;
  /** Sellers already measured for their local date, left alone. */
  readonly skipped: number;
  /** Sellers whose read or store failed; the next run tries them again. */
  readonly failed: number;
}

export interface RunSellerHealthDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly healthRoster: SellerHealthRoster;
  readonly healthStore: SellerHealthStore;
  readonly healthSignals: SellerHealthSignals;
  readonly healthPolicy: SellerHealthPolicy;
  readonly clock: Clock;
}

export interface RunSellerHealthInput {
  /** Waits between two batches; the job passes a real timer, tests pass none. */
  readonly pause?: (ms: number) => Promise<void>;
  /** Told about a seller that failed, so the job can log it without the use case knowing a logger. */
  readonly onFailure?: (sellerId: Id<'Seller'>, error: unknown) => void;
}

/**
 * `sellers.run-seller-health` (seller health package 4; owner decision 1 Nov 2026): for one
 * Market, measures every approved seller whose local date has no snapshot yet. Each seller is cut
 * in its own zone (ADR-0005), so the work follows the sellers' midnights hour by hour; a seller
 * already measured for its local date is skipped, so the run is safe to repeat and to overlap.
 * It counts the last three local days again (late orders and reviews arrive after the day), reads
 * once per source for all three, and stores in a unit of its own per seller. One seller's failure
 * is logged and counted and never stops the others. Sellers go in small batches with a pause
 * between them. Health only writes numbers: no seller is restricted or notified from here (R2).
 * Rule `system`: run by the job only.
 */
export class RunSellerHealth extends UseCase<
  RunSellerHealthInput,
  RunSellerHealthOutput,
  RunSellerHealthFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.run-seller-health',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RunSellerHealthDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RunSellerHealthInput,
  ): Promise<Result<RunSellerHealthOutput, RunSellerHealthFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, healthRoster, clock } = this.deps;
    const total = { measured: 0, skipped: 0, failed: 0 };
    let after: Id<'Seller'> | null = null;
    for (;;) {
      const page = await unitOfWork.run(
        market,
        async () => ok(await healthRoster.page(market, after, SELLER_HEALTH_BATCH)),
        { readOnly: true },
      );
      if (!page.ok) throw new Error('sellers.run-seller-health: the roster unit failed');
      if (page.value.length === 0) break;
      for (const entry of page.value) {
        try {
          const today = Temporal.Instant.fromEpochMilliseconds(clock.now().epochMilliseconds)
            .toZonedDateTimeISO(entry.zone)
            .toPlainDate();
          if (await this.measured(context, entry.sellerId, today)) {
            total.skipped += 1;
            continue;
          }
          const counted = await countSellerHealthDays(
            this.deps.healthSignals,
            context,
            entry.sellerId,
            today,
            entry.zone,
          );
          const stored = await unitOfWork.run(market, async () => {
            await storeSellerHealth(this.storeDeps(), context, entry.sellerId, today, counted);
            return ok(true);
          });
          if (!stored.ok) throw new Error('the unit failed');
          total.measured += 1;
        } catch (error) {
          total.failed += 1;
          input.onFailure?.(entry.sellerId, error);
        }
      }
      after = page.value[page.value.length - 1]!.sellerId;
      if (page.value.length < SELLER_HEALTH_BATCH) break;
      await input.pause?.(SELLER_HEALTH_PAUSE_MS);
    }
    return ok(total);
  }

  private storeDeps() {
    const { healthStore, healthPolicy, clock } = this.deps;
    return { store: healthStore, policy: healthPolicy, clock };
  }

  private async measured(
    context: CallContext,
    sellerId: Id<'Seller'>,
    today: Temporal.PlainDate,
  ): Promise<boolean> {
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () => ok(await this.deps.healthStore.snapshots(context.market, sellerId, today, today)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('the snapshot read failed');
    return read.value.length > 0;
  }
}
