import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { err } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { countSellerHealthDays, storeSellerHealth } from '../health/rollup-seller-health';
import type { SellerHealthPolicy } from '../ports/seller-health-policy';
import type { SellerHealthRequestStore } from '../ports/seller-health-request.store';
import type { SellerHealthRoster } from '../ports/seller-health-roster';
import type { SellerHealthSignals } from '../ports/seller-health-signals';
import type { SellerHealthStore } from '../ports/seller-health.store';

/** Requests per read; the job works through the pending ones in pages of this size. */
export const SELLER_HEALTH_REQUEST_BATCH = 25;
/** Pages one run reads at most, so a flood of requests cannot hold a run for ever. */
export const SELLER_HEALTH_REQUEST_MAX_PAGES = 8;

export type RunSellerHealthRequestsFailure = { readonly code: 'access.denied' };

export interface RunSellerHealthRequestsOutput {
  /** Requests whose seller was measured again. */
  readonly done: number;
  /** Requests that could not be measured (no approved file, or a feed or store failed). */
  readonly failed: number;
}

export interface RunSellerHealthRequestsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly healthRoster: SellerHealthRoster;
  readonly healthRequests: SellerHealthRequestStore;
  readonly healthStore: SellerHealthStore;
  readonly healthSignals: SellerHealthSignals;
  readonly healthPolicy: SellerHealthPolicy;
  readonly clock: Clock;
}

export interface RunSellerHealthRequestsInput {
  /** Told about a request that failed, so the job can log it without knowing a logger. */
  readonly onFailure?: (sellerId: Id<'Seller'>, error: unknown) => void;
}

/**
 * `sellers.run-seller-health-requests` (seller health; option A of 5 Nov 2026): for one Market,
 * measures the sellers that have a pending request, now, in each seller's own zone (ADR-0005), and
 * marks the request done. Unlike the nightly run it measures even when the seller's local date
 * already has a snapshot: that is the point of the request. It counts the same three local days
 * the nightly run counts, so a repeat or an overlap sets the same numbers and never adds twice. A
 * request that fails is marked failed and logged; the next click makes a new one. Health only
 * writes numbers: nothing happens to the seller (R2). Rule `system`: run by the job only.
 */
export class RunSellerHealthRequests extends UseCase<
  RunSellerHealthRequestsInput,
  RunSellerHealthRequestsOutput,
  RunSellerHealthRequestsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.run-seller-health-requests',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RunSellerHealthRequestsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RunSellerHealthRequestsInput,
  ): Promise<Result<RunSellerHealthRequestsOutput, RunSellerHealthRequestsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, healthRequests } = this.deps;
    const total = { done: 0, failed: 0 };
    for (let page = 0; page < SELLER_HEALTH_REQUEST_MAX_PAGES; page += 1) {
      const waiting = await unitOfWork.run(
        market,
        async () => ok(await healthRequests.pending(market, SELLER_HEALTH_REQUEST_BATCH)),
        { readOnly: true },
      );
      if (!waiting.ok) throw new Error('sellers.run-seller-health-requests: the read failed');
      if (waiting.value.length === 0) break;
      for (const request of waiting.value) {
        let outcome: 'done' | 'failed' = 'failed';
        try {
          outcome = (await this.measure(context, request.sellerId)) ? 'done' : 'failed';
        } catch (error) {
          input.onFailure?.(request.sellerId, error);
        }
        total[outcome] += 1;
        await unitOfWork.run(market, async () => {
          await healthRequests.finish(market, request.id, outcome, this.deps.clock.now());
          return ok(true);
        });
      }
      if (waiting.value.length < SELLER_HEALTH_REQUEST_BATCH) break;
    }
    return ok(total);
  }

  /** Measures one seller now; false when it has no approved file (nothing to cut its days by). */
  private async measure(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean> {
    const { market } = context;
    const { unitOfWork, healthRoster, healthSignals, healthStore, healthPolicy, clock } = this.deps;
    const found = await unitOfWork.run(
      market,
      async () => ok(await healthRoster.one(market, sellerId)),
      { readOnly: true },
    );
    if (!found.ok) throw new Error('the roster unit failed');
    const entry = found.value;
    if (entry === null) return false;
    const today = Temporal.Instant.fromEpochMilliseconds(clock.now().epochMilliseconds)
      .toZonedDateTimeISO(entry.zone)
      .toPlainDate();
    const counted = await countSellerHealthDays(
      healthSignals,
      context,
      sellerId,
      today,
      entry.zone,
    );
    const stored = await unitOfWork.run(market, async () => {
      await storeSellerHealth(
        { store: healthStore, policy: healthPolicy, clock },
        context,
        sellerId,
        today,
        counted,
      );
      return ok(true);
    });
    if (!stored.ok) throw new Error('the unit failed');
    return true;
  }
}
