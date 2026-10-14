import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { PriceSeriesRepository } from '../ports/price-series.repository';

/**
 * The boundary job's horizon H (pricing-data 6.2, D 11 M4): a boundary older than this with no
 * marker is never announced. It is an operational value, not a business rule. Prices stay
 * correct without the announcement (design 4.1).
 */
export const BOUNDARY_HORIZON_MS = 7 * 24 * 3_600_000;

/** One run announces at most this many boundaries; the next minute takes the rest (D 11). */
export const BOUNDARY_BATCH_SIZE = 100;

export interface PublishSpecialPriceBoundariesOutput {
  /** Boundaries that got an `effective-price-changed` event. */
  readonly announced: number;
  /** Boundaries marked with nothing to tell (retired series, withdrawn before its start). */
  readonly skipped: number;
  /** Boundaries another run had already marked. */
  readonly alreadyMarked: number;
  /** Units that failed (a concurrent write, a timeout); their boundary is found again next run. */
  readonly failed: number;
}

export type PublishSpecialPriceBoundariesFailure = { readonly code: 'access.denied' };

export interface PublishSpecialPriceBoundariesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * `pricing.publish-special-price-boundaries` (pricing design 11, data design 3.5, 6.2; slice 5).
 * For one Market, tells consumers when a special price started or ended: it finds the boundaries
 * that have come within the horizon and have no marker, and for each one, in a unit of its own,
 * writes the marker first, then raises the series version and appends `effective-price-changed`
 * (`special-started` or `special-ended`). Rule `system`: run by the every-minute job only.
 *
 * Safe to run twice and concurrently: the marker is the claim, so a second run finds it and does
 * nothing, without a version step or an event. A unit that fails (the series was written
 * meanwhile) rolls its marker back and is found again next run, without stopping the others.
 */
export class PublishSpecialPriceBoundaries extends UseCase<
  Record<string, never>,
  PublishSpecialPriceBoundariesOutput,
  PublishSpecialPriceBoundariesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.publish-special-price-boundaries',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('PublishSpecialPriceBoundaries');

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublishSpecialPriceBoundariesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PublishSpecialPriceBoundariesOutput, PublishSpecialPriceBoundariesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, series, outbox, clock } = this.deps;
    const now = clock.now();

    // A failed read throws out of here: the scheduler logs that Market's run as failed.
    const due = await unitOfWork.run(market, async () =>
      ok(
        await series.listDueSpecialBoundaries(
          market,
          now,
          BOUNDARY_HORIZON_MS,
          BOUNDARY_BATCH_SIZE,
        ),
      ),
    );
    if (!due.ok) throw new Error('pricing.publish-special-price-boundaries: the read failed');

    let announced = 0;
    let skipped = 0;
    let alreadyMarked = 0;
    let failed = 0;
    for (const boundary of due.value) {
      try {
        const done = await unitOfWork.run<'announced' | 'skipped' | 'already-marked', never>(
          market,
          async () => {
            // The marker first: a repeated or concurrent run finds it and ends the unit here.
            if (
              !(await series.markSpecialBoundary(market, boundary.recordId, boundary.boundary, now))
            ) {
              return ok('already-marked' as const);
            }
            const found = await series.findByRecordId(market, boundary.recordId);
            if (
              found === null ||
              !found.announceSpecialBoundary(boundary.recordId, boundary.boundary, now)
            ) {
              return ok('skipped' as const);
            }
            await series.save(market, found);
            await outbox.append(context, found.pendingEvents);
            return ok('announced' as const);
          },
        );
        if (!done.ok) throw new Error('the unit failed');
        if (done.value === 'announced') announced += 1;
        else if (done.value === 'skipped') skipped += 1;
        else alreadyMarked += 1;
      } catch (error) {
        failed += 1;
        // No ids of prices or people: the record id and the error class are enough to look it up.
        this.#logger.warn({
          msg: 'pricing.publish-special-price-boundaries.unit-failed',
          recordId: boundary.recordId,
          boundary: boundary.boundary,
          error: error instanceof Error ? error.name : 'unknown',
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
    }
    return ok({ announced, skipped, alreadyMarked, failed });
  }
}
