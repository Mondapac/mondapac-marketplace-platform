import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Reservation, type ReleaseCause } from '../../domain/reservation';
import { heldByItem, type HeldLine } from '../../domain/sellable-calculator';
import type {
  CommitAssignment,
  CommittedLineRow,
  ReservationRepository,
  SellUnitRef,
} from '../ports/reservation.repository';
import type { StockItemRow } from '../ports/stock.repository';

/**
 * An in-memory {@link ReservationRepository} for the unit specs: the same rules as the Prisma
 * adapter (held sum from the domain's `heldByItem`, guarded release and expiry, one ACTIVE
 * reservation per holder), none of its SQL. PostgreSQL behaviour is in the db-specs.
 */
export class InMemoryReservations implements ReservationRepository {
  /** The stock items, shared with the test; the lock only records the order it was asked in. */
  items: StockItemRow[] = [];
  readonly limits = new Map<Id<'Offer'>, number>();
  readonly stored = new Map<Id<'Reservation'>, Reservation>();
  /** Every `lockItems` call, in order, as the ids the caller passed. */
  readonly lockCalls: (readonly Id<'StockItem'>[])[] = [];
  /** Set to make the next `insert` find a racing reservation of the same holder. */
  holderConflictOnInsert = false;

  itemsOfSellUnits(_m: MarketContext, keys: readonly SellUnitRef[]) {
    const wanted = new Set(keys.map((k) => `${k.offerId}/${k.variantId}`));
    return Promise.resolve(
      this.items
        .filter((i) => wanted.has(`${i.offerId}/${i.variantId}`))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  }

  lockItems(_m: MarketContext, ids: readonly Id<'StockItem'>[]) {
    this.lockCalls.push([...ids]);
    const wanted = new Set(ids);
    return Promise.resolve(
      this.items.filter((i) => wanted.has(i.id)).sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  }

  readonly marked: (readonly Id<'StockItem'>[])[] = [];
  markHoldsChanged(_m: MarketContext, ids: readonly Id<'StockItem'>[]) {
    this.marked.push([...ids]);
    return Promise.resolve();
  }

  heldQuantities(_m: MarketContext, ids: readonly Id<'StockItem'>[], now: Temporal.Instant) {
    const lines: HeldLine[] = [...this.stored.values()].flatMap((r) =>
      r.state.lines.map((line) => ({
        stockItemId: line.stockItemId,
        status: line.status,
        expiresAt: r.state.expiresAt,
        quantity: line.quantity,
      })),
    );
    const held = heldByItem(lines, now);
    return Promise.resolve(new Map(ids.map((id) => [id, held.get(id) ?? 0] as const)));
  }

  purchaseLimits(_m: MarketContext, offerIds: readonly Id<'Offer'>[]) {
    return Promise.resolve(
      new Map(
        offerIds.flatMap((id) => {
          const limit = this.limits.get(id);
          return limit === undefined ? [] : [[id, limit] as const];
        }),
      ),
    );
  }

  findActiveByHolder(_m: MarketContext, holder: Id<'Account'>) {
    return Promise.resolve(
      [...this.stored.values()].find(
        (r) => r.state.holderAccountId === holder && r.state.status === 'active',
      ) ?? null,
    );
  }

  findById(_m: MarketContext, id: Id<'Reservation'>) {
    return Promise.resolve(this.stored.get(id) ?? null);
  }

  insert(_m: MarketContext, reservation: Reservation) {
    if (this.holderConflictOnInsert) {
      this.holderConflictOnInsert = false;
      return Promise.resolve('holder-conflict' as const);
    }
    this.stored.set(reservation.state.id, reservation);
    return Promise.resolve('inserted' as const);
  }

  releaseActive(
    _m: MarketContext,
    id: Id<'Reservation'>,
    cause: ReleaseCause,
    now: Temporal.Instant,
  ) {
    const found = this.stored.get(id);
    const decision = found?.release(cause, now);
    if (!decision?.ok || decision.value.outcome !== 'released') return Promise.resolve(false);
    this.stored.set(id, decision.value.next);
    return Promise.resolve(true);
  }

  expireDue(_m: MarketContext, ids: readonly Id<'Reservation'>[], now: Temporal.Instant) {
    const changed: Id<'Reservation'>[] = [];
    for (const id of ids) {
      const next = this.stored.get(id)?.expire(now);
      if (next != null) {
        this.stored.set(id, next);
        changed.push(id);
      }
    }
    return Promise.resolve(changed);
  }

  dueForExpiry(_m: MarketContext, now: Temporal.Instant, limit: number) {
    return Promise.resolve(
      [...this.stored.values()].filter((r) => r.isExpiredAt(now)).slice(0, limit),
    );
  }

  liveOnSellUnits(_m: MarketContext, keys: readonly SellUnitRef[], now: Temporal.Instant) {
    const wanted = new Set(keys.map((k) => `${k.offerId}/${k.variantId}`));
    return Promise.resolve(
      [...this.stored.values()].filter(
        (r) =>
          r.isLiveAt(now) && r.state.lines.some((l) => wanted.has(`${l.offerId}/${l.variantId}`)),
      ),
    );
  }

  commit(
    _m: MarketContext,
    id: Id<'Reservation'>,
    assignments: readonly CommitAssignment[],
    now: Temporal.Instant,
  ) {
    const found = this.stored.get(id);
    if (found === undefined) return Promise.resolve(false);
    const { status, releaseCause } = found.state;
    if (!(status === 'active' || status === 'expired' || releaseCause === 'superseded')) {
      return Promise.resolve(false);
    }
    const byLine = new Map(assignments.map((a) => [a.lineId as string, a]));
    this.stored.set(
      id,
      Reservation.fromStored({
        ...found.state,
        status: 'committed',
        statusChangedAt: now,
        version: found.state.version + 1,
        lines: found.state.lines.map((line) => {
          const a = byLine.get(line.id);
          return a === undefined
            ? line
            : {
                ...line,
                status: 'committed' as const,
                orderLineId: a.orderLineId,
                stockItemId: a.stockItemId,
              };
        }),
      }),
    );
    return Promise.resolve(true);
  }

  findLineByOrderLine(_m: MarketContext, orderLineId: string) {
    for (const r of this.stored.values()) {
      const line = r.state.lines.find((l) => l.orderLineId === orderLineId);
      if (line !== undefined) {
        const row: CommittedLineRow = {
          lineId: line.id,
          reservationId: r.state.id,
          offerId: line.offerId,
          variantId: line.variantId,
          stockItemId: line.stockItemId,
          quantity: line.quantity,
          status: line.status,
        };
        return Promise.resolve(row);
      }
    }
    return Promise.resolve(null);
  }

  finishLine(_m: MarketContext, lineId: Id<'ReservationLine'>, to: 'cancelled' | 'fulfilled') {
    for (const r of this.stored.values()) {
      const line = r.state.lines.find((l) => l.id === lineId);
      if (line === undefined) continue;
      if (line.status !== 'committed') return Promise.resolve(false);
      this.stored.set(
        r.state.id,
        Reservation.fromStored({
          ...r.state,
          lines: r.state.lines.map((l) => (l.id === lineId ? { ...l, status: to } : l)),
        }),
      );
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  /** Every `shipUnits` call, in order. */
  readonly shipped: { id: Id<'StockItem'>; quantity: number }[] = [];
  shipUnits(_m: MarketContext, id: Id<'StockItem'>, quantity: number) {
    const at = this.items.findIndex((i) => i.id === id);
    const item = this.items[at];
    if (item === undefined || item.onHand < quantity) return Promise.resolve(null);
    this.items[at] = { ...item, onHand: item.onHand - quantity, version: item.version + 1 };
    this.shipped.push({ id, quantity });
    return Promise.resolve(item.onHand - quantity);
  }

  pruneTerminal(_m: MarketContext, before: Temporal.Instant, limit: number) {
    const due = [...this.stored.values()]
      .filter(
        (r) =>
          (r.state.status === 'released' || r.state.status === 'expired') &&
          Temporal.Instant.compare(r.state.statusChangedAt, before) < 0,
      )
      .slice(0, limit);
    for (const r of due) this.stored.delete(r.state.id);
    return Promise.resolve(due.length);
  }
}
