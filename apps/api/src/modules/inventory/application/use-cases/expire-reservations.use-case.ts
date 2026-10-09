import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TransactionConflictError } from '../../../../platform/unit-of-work/errors';
import type { Reservation } from '../../domain/reservation';
import {
  distinctSellUnits,
  recomputeSellUnitSignals,
  type SignalRecomputeDependencies,
} from '../reservation-support';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';

/** Reservations examined per unit (design 11: bounded batches, one unit per batch). */
export const EXPIRY_BATCH_SIZE = 20;
/** At most this many batches per run; the next minute continues. */
export const MAX_EXPIRY_BATCHES_PER_RUN = 25;
/** The statement cap of `inventory.lock-stock-items` (data design 4.3). */
const MAX_LOCK_SET = 1000;
const LOCK_TIMEOUT_MS = 3000;

export interface ExpireReservationsOutput {
  /** Reservations whose status this run set to `expired`. */
  readonly expired: number;
  /** Batches that failed on a lock wait or a deadlock; the next run retries them. */
  readonly contended: number;
}

export type ExpireReservationsFailure = { readonly code: 'access.denied' };

export interface ExpireReservationsDependencies extends SignalRecomputeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * `inventory.expire-reservations`, every minute (inventory design 11, 3.1; data design 4.4): the
 * cleanup that sets `expired` on ACTIVE reservations past their expiry and publishes the signal
 * changes that follow. Rule `system`, one call per hosted Market. Correctness never depends on it:
 * sellable is derived from `expiresAt` at every read (design 4.1, AC 4).
 *
 * Per batch of at most 20 candidates, one unit: read the candidates without a lock, lock every
 * non-retired item of their sell units and their own items in one ascending statement (L1; the
 * batch is trimmed to stay under the statement's 1,000 ids), set `status = 'expired'` guarded on
 * `status = 'active'`, recompute the signals, append the events. Safe to run twice and
 * concurrently (PE 7): the guard changes each row once.
 */
export class ExpireReservations extends UseCase<
  Record<string, never>,
  ExpireReservationsOutput,
  ExpireReservationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.expire-reservations',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ExpireReservations');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ExpireReservationsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ExpireReservationsOutput, ExpireReservationsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    let expired = 0;
    let contended = 0;
    for (let batch = 0; batch < MAX_EXPIRY_BATCHES_PER_RUN; batch += 1) {
      let outcome: Result<{ found: number; expired: number }, never>;
      try {
        outcome = await this.deps.unitOfWork.run(market, () => this.expireBatch(context), {
          lockTimeoutMs: LOCK_TIMEOUT_MS,
        });
      } catch (error) {
        if (!(error instanceof TransactionConflictError)) throw error;
        contended += 1;
        break;
      }
      if (!outcome.ok) break;
      expired += outcome.value.expired;
      // Nothing due, or every candidate was taken by a concurrent run: stop instead of spinning.
      if (outcome.value.found < EXPIRY_BATCH_SIZE || outcome.value.expired === 0) break;
    }
    this.#logger.log({
      msg: 'inventory.expire-reservations.done',
      expired,
      contended,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ expired, contended });
  }

  private async expireBatch(
    context: CallContext,
  ): Promise<Result<{ found: number; expired: number }, never>> {
    const { market } = context;
    const { reservations, clock } = this.deps;
    const now = clock.now();
    const due = await reservations.dueForExpiry(market, now, EXPIRY_BATCH_SIZE);
    if (due.length === 0) return ok({ found: 0, expired: 0 });

    const known = await reservations.itemsOfSellUnits(
      market,
      due.flatMap((reservation) => reservation.state.lines),
    );
    const chosen = fitLockSet(due, known);
    const sellUnits = distinctSellUnits(chosen.flatMap((reservation) => reservation.state.lines));
    const ids = new Set<Id<'StockItem'>>(
      chosen.flatMap((reservation) => reservation.state.lines.map((line) => line.stockItemId)),
    );
    for (const item of known) {
      if (
        !item.retired &&
        sellUnits.some((u) => u.offerId === item.offerId && u.variantId === item.variantId)
      ) {
        ids.add(item.id);
      }
    }
    const locked = await reservations.lockItems(market, [...ids]);
    const changed = await reservations.expireDue(
      market,
      chosen.map((reservation) => reservation.state.id),
      now,
    );
    if (changed.length > 0) {
      const done = new Set(changed);
      const units = chosen
        .filter((reservation) => done.has(reservation.state.id))
        .flatMap((reservation) => reservation.state.lines);
      await recomputeSellUnitSignals(this.deps, context, market, locked, units, now);
    }
    return ok({ found: due.length, expired: changed.length });
  }
}

/**
 * The longest prefix of the candidates whose lock set (every non-retired item of their sell units
 * plus their own items) fits the statement; at least one reservation, which always fits (at most
 * 50 lines of at most 4 sources).
 */
function fitLockSet(
  due: readonly Reservation[],
  known: readonly { id: Id<'StockItem'>; offerId: string; variantId: string; retired: boolean }[],
): readonly Reservation[] {
  for (let count = due.length; count > 1; count -= 1) {
    const prefix = due.slice(0, count);
    const units = new Set(
      prefix.flatMap((r) => r.state.lines.map((line) => `${line.offerId}/${line.variantId}`)),
    );
    const ids = new Set<string>(
      prefix.flatMap((r) => r.state.lines.map((line) => line.stockItemId)),
    );
    for (const item of known) {
      if (!item.retired && units.has(`${item.offerId}/${item.variantId}`)) ids.add(item.id);
    }
    if (ids.size <= MAX_LOCK_SET) return prefix;
  }
  return due.slice(0, 1);
}
