import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ReleaseCause, Reservation } from '../../domain/reservation';
import { heldByItem, type HeldLine } from '../../domain/sellable-calculator';
import type { ReservationRepository, SellUnitRef } from '../ports/reservation.repository';
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
}
