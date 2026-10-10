import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import type { ReleaseFailure, ReleaseResult } from '../contracts/ordering-port';
import type { ReleaseCause } from '../domain/reservation';
import {
  lockSellUnitsOf,
  recomputeSellUnitSignals,
  type SignalRecomputeDependencies,
} from './reservation-support';

export interface ReleaseDependencies extends SignalRecomputeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/** Same lock wait as `reserve` (design 4.2 step 2). */
const LOCK_TIMEOUT_MS = 3000;

/**
 * ACTIVE to RELEASED with a cause (design 3.1, 4.4): load the reservation, lock every non-retired
 * item of its sell units plus its own items (L1), release it with a guard on `status = 'active'`,
 * recompute the signals. `ownedBy` is the customer's account on the own-resources path: a
 * reservation of someone else answers the same `not-found` as an unknown id. A repeat on a
 * RELEASED or EXPIRED reservation succeeds and keeps the stored cause (design 10); a COMMITTED one
 * is refused (design 3.2).
 */
export async function releaseReservation(
  deps: ReleaseDependencies,
  context: CallContext,
  reservationId: Id<'Reservation'>,
  cause: ReleaseCause,
  ownedBy: Id<'Account'> | null,
): Promise<Result<ReleaseResult, ReleaseFailure>> {
  const { market } = context;
  try {
    return await deps.unitOfWork.run<ReleaseResult, ReleaseFailure>(
      market,
      () => release(deps, context, market, reservationId, cause, ownedBy),
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof TransactionConflictError) return err({ code: 'conflict.retry' });
    throw error;
  }
}

async function release(
  deps: ReleaseDependencies,
  context: CallContext,
  market: MarketContext,
  reservationId: Id<'Reservation'>,
  cause: ReleaseCause,
  ownedBy: Id<'Account'> | null,
): Promise<Result<ReleaseResult, ReleaseFailure>> {
  const { reservations } = deps;
  const now = deps.clock.now();
  const found = await reservations.findById(market, reservationId);
  if (found === null || (ownedBy !== null && found.state.holderAccountId !== ownedBy)) {
    return err({ code: 'inventory.reservation.not-found' });
  }
  const decision = found.release(cause, now);
  if (!decision.ok) return err({ code: 'inventory.reservation.committed' });
  if (decision.value.outcome === 'unchanged') return ok({ reservationId });

  const { all: locked } = await lockSellUnitsOf(
    reservations,
    market,
    found.state.lines,
    found.state.lines.map((line) => line.stockItemId),
  );
  // Guarded: another unit (the expiry job, a newer reserve) may have moved it since the read.
  const released = await reservations.releaseActive(market, reservationId, cause, now);
  if (released) {
    await recomputeSellUnitSignals(deps, context, market, locked, found.state.lines, now);
  } else {
    // Changed 0 rows: another unit moved it first. A commit is a refusal, not a success (L1).
    const again = await reservations.findById(market, reservationId);
    if (again?.state.status === 'committed')
      return err({ code: 'inventory.reservation.committed' });
  }
  return ok({ reservationId });
}
