import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  MarketContext,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TransactionConflictError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_RESERVE_LINES,
  type CommitFailure,
  type CommitRequest,
  type ReleaseResult,
} from '../../contracts/ordering-port';
import {
  AllocationPolicy,
  type AllocationRequest,
  type LineFailure,
} from '../../domain/allocation-policy';
import type { CommitMapping, Reservation } from '../../domain/reservation';
import { SellableCalculator } from '../../domain/sellable-calculator';
import type { CommitAssignment } from '../ports/reservation.repository';
import type { StockItemRow } from '../ports/stock.repository';
import {
  insufficientOf,
  lockSellUnitsOf,
  recomputeSellUnitSignals,
  sellerPriorities,
  type SignalRecomputeDependencies,
} from '../reservation-support';
import { validationFailed } from '../source-use-case-support';

export interface CommitReservationDependencies extends SignalRecomputeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/** Same lock wait as `reserve` (design 4.2 step 2). */
const LOCK_TIMEOUT_MS = 3000;

const CONFLICT_RETRY = Object.freeze({ code: 'conflict.retry' as const });

/**
 * `inventory.commit-reservation` (inventory design 3.1, 7.2, 10): `ordering` turns the hold into
 * pending ordered quantity, before it captures payment. Rule `system`.
 *
 * The `checkoutRef` and the mapping (every line once, distinct order lines) must fit, else
 * `inventory.commit-mismatch`. A live ACTIVE reservation is committed where it is. An expired
 * one, an EXPIRED one and one RELEASED as `superseded` are allocated again under lock for the
 * same lines (no cap check: it was made at `reserve`); if all fit the lines are re-pointed and
 * committed, else `inventory.insufficient` and the reservation keeps its status. A reservation
 * RELEASED for any other cause is final: refused, nothing taken. A repeat with the same mapping
 * changes nothing.
 */
export class CommitReservation extends UseCase<CommitRequest, ReleaseResult, CommitFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.commit-reservation',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommitReservationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CommitRequest,
  ): Promise<Result<ReleaseResult, CommitFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const checked = check(input);
    if (!checked.ok) return checked;
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<ReleaseResult, CommitFailure>(
        market,
        () => this.commit(context, market, checked.value),
        { lockTimeoutMs: LOCK_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof TransactionConflictError) return err(CONFLICT_RETRY);
      throw error;
    }
  }

  private async commit(
    context: CallContext,
    market: MarketContext,
    input: Checked,
  ): Promise<Result<ReleaseResult, CommitFailure>> {
    const { reservations, clock } = this.deps;
    const first = await reservations.findById(market, input.reservationId);
    if (first === null) return err({ code: 'inventory.reservation.not-found' });
    const early = first.decideCommit(input.checkoutRef, input.mapping, clock.now());
    if (early === 'mismatch') return err({ code: 'inventory.commit-mismatch' });
    if (early === 'already-committed') return ok({ reservationId: input.reservationId });
    if (early === 'refused') return err(refusedFor(first));

    // Lock (L1), then decide again on a new statement: the expiry job, a release or a newer
    // reserve may have moved the reservation since the read.
    const { all: locked, known } = await lockSellUnitsOf(
      reservations,
      market,
      first.state.lines,
      first.state.lines.map((line) => line.stockItemId),
    );
    const current = await reservations.findById(market, input.reservationId);
    if (current === null) return err({ code: 'inventory.reservation.not-found' });
    // The lock wait can take seconds: decide on a fresh instant, or a hold that expired meanwhile
    // (and was reallocated to another buyer) would be committed in place.
    const now = clock.now();
    const decision = current.decideCommit(input.checkoutRef, input.mapping, now);
    if (decision === 'mismatch') return err({ code: 'inventory.commit-mismatch' });
    if (decision === 'already-committed') return ok({ reservationId: input.reservationId });
    if (decision === 'refused') return err(refusedFor(current));

    for (const entry of input.mapping) {
      // An order line already on another reservation is a bug upstream; refuse it cleanly.
      if ((await reservations.findLineByOrderLine(market, entry.orderLineId)) !== null) {
        return err({ code: 'inventory.commit-mismatch' });
      }
    }
    const orderLineOf = new Map(
      input.mapping.map((e) => [e.reservationLineId as string, e.orderLineId]),
    );
    let assignments: CommitAssignment[];
    if (decision === 'commit-in-place') {
      assignments = current.state.lines.map((line) => ({
        lineId: line.id,
        orderLineId: orderLineOf.get(line.id)!,
        stockItemId: line.stockItemId,
      }));
    } else {
      const placed = await this.reallocate(market, current, locked, known, now);
      if (!placed.ok) return placed;
      assignments = current.state.lines.map((line) => ({
        lineId: line.id,
        orderLineId: orderLineOf.get(line.id)!,
        stockItemId: placed.value.get(`${line.offerId}/${line.variantId}`)!,
      }));
    }
    if (!(await reservations.commit(market, current.state.id, assignments, now))) {
      return err(CONFLICT_RETRY);
    }
    await recomputeSellUnitSignals(this.deps, context, market, locked, current.state.lines, now);
    return ok({ reservationId: input.reservationId });
  }

  /** The same lines allocated again on the locked items: sell unit to the chosen stock item. */
  private async reallocate(
    market: MarketContext,
    reservation: Reservation,
    locked: readonly StockItemRow[],
    known: readonly StockItemRow[],
    now: Temporal.Instant,
  ): Promise<Result<Map<string, Id<'StockItem'>>, CommitFailure>> {
    const { reservations, inventories } = this.deps;
    const held = await reservations.heldQuantities(
      market,
      locked.map((i) => i.id),
      now,
    );
    const priorities = await sellerPriorities(inventories, market, locked);
    const failures: LineFailure[] = [];
    const requests: AllocationRequest[] = [];
    for (const line of reservation.state.lines) {
      const items = locked.filter(
        (i) => i.offerId === line.offerId && i.variantId === line.variantId && !i.retired,
      );
      if (items.length === 0) {
        const retired = known.some(
          (i) => i.offerId === line.offerId && i.variantId === line.variantId && i.retired,
        );
        failures.push({
          offerId: line.offerId,
          variantId: line.variantId,
          reason: retired ? 'retired' : 'out',
        });
        continue;
      }
      requests.push({
        offerId: line.offerId,
        variantId: line.variantId,
        quantity: line.quantity,
        candidates: [...items]
          .sort((a, b) => priorities.rankOf(a) - priorities.rankOf(b))
          .map((item) => ({
            stockItemId: item.id,
            sellable: SellableCalculator.ofItem(item.onHand, held.get(item.id) ?? 0),
          })),
      });
    }
    const allocated = AllocationPolicy.allocate(requests);
    if (!allocated.ok) failures.push(...allocated.failures);
    if (failures.length > 0 || !allocated.ok) {
      return err(insufficientOf(reservation.state.lines, failures));
    }
    return ok(
      new Map(allocated.allocations.map((a) => [`${a.offerId}/${a.variantId}`, a.stockItemId])),
    );
  }
}

interface Checked {
  readonly reservationId: Id<'Reservation'>;
  readonly checkoutRef: string;
  readonly mapping: readonly CommitMapping[];
}

/** A final release: nothing is taken and nothing fits (design 3.1). */
function refusedFor(reservation: Reservation): CommitFailure {
  return insufficientOf(
    reservation.state.lines,
    reservation.state.lines.map((line) => ({
      offerId: line.offerId,
      variantId: line.variantId,
      reason: 'out' as const,
    })),
  );
}

function check(input: CommitRequest): Result<Checked, CommitFailure> {
  const fields: { path: string; code: string }[] = [];
  const reservationId =
    typeof input?.reservationId === 'string' ? parseId<'Reservation'>(input.reservationId) : null;
  if (reservationId === null || !reservationId.ok)
    fields.push({ path: 'reservationId', code: 'format' });
  const checkoutRef = typeof input?.checkoutRef === 'string' ? parseId(input.checkoutRef) : null;
  if (checkoutRef === null || !checkoutRef.ok) fields.push({ path: 'checkoutRef', code: 'format' });
  if (
    !Array.isArray(input?.lines) ||
    input.lines.length === 0 ||
    input.lines.length > MAX_RESERVE_LINES
  ) {
    fields.push({ path: 'lines', code: 'type' });
    return validationFailed(fields);
  }
  const mapping: CommitMapping[] = [];
  for (const [at, raw] of (input.lines as readonly unknown[]).entries()) {
    const line = raw as { reservationLineId?: unknown; orderLineId?: unknown } | null;
    const lineId =
      typeof line?.reservationLineId === 'string'
        ? parseId<'ReservationLine'>(line.reservationLineId)
        : null;
    const orderLine = typeof line?.orderLineId === 'string' ? parseId(line.orderLineId) : null;
    if (lineId === null || !lineId.ok)
      fields.push({ path: `lines.${at}.reservationLineId`, code: 'format' });
    if (orderLine === null || !orderLine.ok)
      fields.push({ path: `lines.${at}.orderLineId`, code: 'format' });
    if (lineId?.ok === true && orderLine?.ok === true) {
      mapping.push({ reservationLineId: lineId.value, orderLineId: orderLine.value });
    }
  }
  if (
    fields.length > 0 ||
    reservationId === null ||
    !reservationId.ok ||
    checkoutRef === null ||
    !checkoutRef.ok
  ) {
    return validationFailed(fields);
  }
  return ok({ reservationId: reservationId.value, checkoutRef: checkoutRef.value, mapping });
}
