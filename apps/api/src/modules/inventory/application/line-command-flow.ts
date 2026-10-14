import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { LineCommandFailure } from '../contracts/ordering-port';
import { cancelLineDecision, shipLineDecision } from '../domain/reservation';
import type { StockRepository } from './ports/stock.repository';
import {
  lockSellUnitsOf,
  recomputeSellUnitSignals,
  type SignalRecomputeDependencies,
} from './reservation-support';

export interface LineCommandDependencies extends SignalRecomputeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly stock: StockRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** Same lock wait as `reserve` (design 4.2 step 2). */
const LOCK_TIMEOUT_MS = 3000;

export type LineCommand = 'cancel' | 'ship';

/**
 * A committed line goes to CANCELLED (the units are sellable again) or to FULFILLED (the source's
 * on-hand goes down and a `shipment` movement is written), keyed by its order line (design 3.2, 10).
 * The line is read, the sell unit's items are locked (L1; retired ones too, a retired item still
 * ships and cancels, design 3.3), the line is read again on a new statement and the transition is
 * guarded on `state = 'committed'`. Repeating the same command succeeds and writes nothing; the
 * opposite command on a finished line is `inventory.line.final`.
 */
export async function runLineCommand(
  deps: LineCommandDependencies,
  context: CallContext,
  command: LineCommand,
  orderLineId: string,
): Promise<Result<{ readonly orderLineId: string }, LineCommandFailure>> {
  const { market } = context;
  try {
    return await deps.unitOfWork.run<{ readonly orderLineId: string }, LineCommandFailure>(
      market,
      () => apply(deps, context, market, command, orderLineId),
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof TransactionConflictError) return err({ code: 'conflict.retry' });
    throw error;
  }
}

async function apply(
  deps: LineCommandDependencies,
  context: CallContext,
  market: MarketContext,
  command: LineCommand,
  orderLineId: string,
): Promise<Result<{ readonly orderLineId: string }, LineCommandFailure>> {
  const { reservations } = deps;
  const decide = command === 'cancel' ? cancelLineDecision : shipLineDecision;
  const first = await reservations.findLineByOrderLine(market, orderLineId);
  if (first === null) return err({ code: 'inventory.line.not-found' });
  const early = decide(first.status);
  if (early === 'unchanged') return ok({ orderLineId });
  if (early === 'refused') return err({ code: 'inventory.line.final' });

  const { all: locked } = await lockSellUnitsOf(reservations, market, [first], [first.stockItemId]);
  const line = await reservations.findLineByOrderLine(market, orderLineId);
  if (line === null) return err({ code: 'inventory.line.not-found' });
  const decision = decide(line.status);
  if (decision === 'unchanged') return ok({ orderLineId });
  if (decision === 'refused') return err({ code: 'inventory.line.final' });

  const now = deps.clock.now();
  const moved = await reservations.finishLine(
    market,
    line.lineId,
    command === 'cancel' ? 'cancelled' : 'fulfilled',
    now,
  );
  if (!moved) return err({ code: 'conflict.retry' });
  if (command === 'ship') {
    const onHand = await reservations.shipUnits(market, line.stockItemId, line.quantity);
    // The invariant of design 4.5 keeps on-hand at or above the committed quantity; a breach
    // rolls the unit back and is a bug to alert on, never a silent clamp.
    if (onHand === null) throw new Error('inventory: shipment of more than the item has on hand');
    await deps.stock.appendMovement(market, {
      id: deps.ids.next<'StockMovement'>(),
      stockItemId: line.stockItemId,
      offerId: line.offerId,
      variantId: line.variantId,
      delta: -line.quantity,
      resultingOnHand: onHand,
      reason: 'shipment',
      correlationId: context.correlationId,
      occurredAt: now,
    });
  }
  await recomputeSellUnitSignals(deps, context, market, locked, [line], now);
  return ok({ orderLineId });
}
