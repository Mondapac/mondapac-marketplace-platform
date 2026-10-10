import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import { Temporal as T } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ReservationRepository,
  SellUnitRef,
} from '../application/ports/reservation.repository';
import type { StockItemRow } from '../application/ports/stock.repository';
import {
  Reservation,
  type ReleaseCause,
  type ReservationLineStatus,
  type ReservationStatus,
} from '../domain/reservation';
import { MAX_STOCK_ITEM_IDS } from './lock-limits';
import { heldQuantitiesOf } from './held-sum';
import { toStockItemRow } from './prisma-stock.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant => T.Instant.fromEpochMilliseconds(date.getTime());

/** The most ids the lock statement takes (data design 4.3); a longer list is a caller bug. */
const MAX_LOCKED_STOCK_ITEMS = MAX_STOCK_ITEM_IDS;

interface HeaderRow {
  readonly id: string;
  readonly holderAccountId: string;
  readonly checkoutRef: string;
  readonly status: string;
  readonly releaseCause: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly statusChangedAt: Date;
  readonly version: number;
  readonly lines: readonly {
    readonly id: string;
    readonly offerId: string;
    readonly variantId: string;
    readonly stockItemId: string;
    readonly quantity: number;
    readonly state: string;
  }[];
}

function toReservation(row: HeaderRow): Reservation {
  return Reservation.fromStored({
    id: row.id as Id<'Reservation'>,
    holderAccountId: row.holderAccountId as Id<'Account'>,
    checkoutRef: row.checkoutRef,
    status: row.status as ReservationStatus,
    releaseCause: row.releaseCause as ReleaseCause | null,
    expiresAt: toInstant(row.expiresAt),
    createdAt: toInstant(row.createdAt),
    statusChangedAt: toInstant(row.statusChangedAt),
    version: row.version,
    lines: [...row.lines]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((line) => ({
        id: line.id as Id<'ReservationLine'>,
        offerId: line.offerId as Id<'Offer'>,
        variantId: line.variantId as Id<'Variant'>,
        stockItemId: line.stockItemId as Id<'StockItem'>,
        quantity: line.quantity,
        status: line.state as ReservationLineStatus,
      })),
  });
}

/**
 * {@link ReservationRepository} on `inventory.reservations`, `reservation_lines` and
 * `offer_purchase_limits` (data design 3.6 to 3.8, 4.4). Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top level of `where`; the lock is the named
 * statement `inventory.lock-stock-items`.
 */
export class PrismaReservationRepository implements ReservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async itemsOfSellUnits(
    market: MarketContext,
    keys: readonly SellUnitRef[],
  ): Promise<readonly StockItemRow[]> {
    if (keys.length === 0) return [];
    const wanted = new Set(keys.map((key) => `${key.offerId}/${key.variantId}`));
    const rows = await this.prisma.tx(market).inventoryStockItem.findMany({
      where: {
        marketId: market.marketId,
        offerId: { in: [...new Set(keys.map((key) => key.offerId))] },
        variantId: { in: [...new Set(keys.map((key) => key.variantId))] },
      },
      orderBy: { id: 'asc' },
    });
    return rows
      .filter((row) => wanted.has(`${row.offerId}/${row.variantId}`))
      .map((row) =>
        toStockItemRow({
          id: row.id,
          offerId: row.offerId,
          variantId: row.variantId,
          sourceId: row.sourceId,
          sellerId: row.sellerId,
          onHand: row.onHand,
          retiredAt: row.retiredAt,
          version: row.version,
        }),
      );
  }

  async lockItems(
    market: MarketContext,
    ids: readonly Id<'StockItem'>[],
  ): Promise<readonly StockItemRow[]> {
    const unique = [...new Set(ids)].sort();
    if (unique.length === 0) return [];
    if (unique.length > MAX_LOCKED_STOCK_ITEMS) {
      throw new Error(
        'inventory: a reservation unit asked to lock more items than the statement takes',
      );
    }
    // One statement, `ORDER BY id`: the global lock order that rules out deadlocks (L2).
    const locked = await this.prisma.namedQuery(market, 'inventory.lock-stock-items', {
      ids: unique,
    });
    // Under the lock: tell SERIALIZABLE stock units that holds may have changed (H1).
    await this.markHoldsChanged(market, unique);
    return locked.map(toStockItemRow);
  }

  async markHoldsChanged(market: MarketContext, ids: readonly Id<'StockItem'>[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    // Not `version`: a hold must not make the seller's stock form stale (design C5).
    await this.prisma.tx(market).inventoryStockItem.updateMany({
      where: { marketId: market.marketId, id: { in: unique } },
      data: { holdSeq: { increment: 1 } },
    });
  }

  heldQuantities(
    market: MarketContext,
    ids: readonly Id<'StockItem'>[],
    now: Temporal.Instant,
  ): Promise<ReadonlyMap<Id<'StockItem'>, number>> {
    return heldQuantitiesOf(this.prisma, market, ids, now);
  }

  async purchaseLimits(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, number>> {
    if (offerIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).inventoryOfferPurchaseLimit.findMany({
      where: { marketId: market.marketId, offerId: { in: [...new Set(offerIds)] } },
      select: { offerId: true, maxPerCustomer: true },
    });
    return new Map(rows.map((row) => [row.offerId as Id<'Offer'>, row.maxPerCustomer] as const));
  }

  async findActiveByHolder(
    market: MarketContext,
    holderAccountId: Id<'Account'>,
  ): Promise<Reservation | null> {
    const row = await this.prisma.tx(market).inventoryReservation.findFirst({
      where: { marketId: market.marketId, holderAccountId, status: 'active' },
      include: { lines: true },
    });
    return row === null ? null : toReservation(row);
  }

  async findById(market: MarketContext, id: Id<'Reservation'>): Promise<Reservation | null> {
    const row = await this.prisma.tx(market).inventoryReservation.findFirst({
      where: { marketId: market.marketId, id },
      include: { lines: true },
    });
    return row === null ? null : toReservation(row);
  }

  async insert(
    market: MarketContext,
    reservation: Reservation,
  ): Promise<'inserted' | 'holder-conflict'> {
    const { state } = reservation;
    // `skipDuplicates` is ON CONFLICT DO NOTHING: a racing ACTIVE reservation of the same holder
    // leaves a count of 0 instead of an aborted transaction (the partial unique key, 3.6).
    const { count } = await this.prisma.tx(market).inventoryReservation.createMany({
      data: [
        {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          holderAccountId: state.holderAccountId,
          checkoutRef: state.checkoutRef,
          status: state.status,
          releaseCause: state.releaseCause,
          expiresAt: toDate(state.expiresAt),
          createdAt: toDate(state.createdAt),
          statusChangedAt: toDate(state.statusChangedAt),
          version: state.version,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return 'holder-conflict';
    await this.prisma.tx(market).inventoryReservationLine.createMany({
      data: state.lines.map((line) => ({
        id: line.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        reservationId: state.id,
        expiresAt: toDate(state.expiresAt),
        offerId: line.offerId,
        variantId: line.variantId,
        stockItemId: line.stockItemId,
        quantity: line.quantity,
        state: line.status,
        orderLineId: null,
        stateChangedAt: toDate(state.statusChangedAt),
      })),
    });
    return 'inserted';
  }

  async releaseActive(
    market: MarketContext,
    id: Id<'Reservation'>,
    cause: ReleaseCause,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).inventoryReservation.updateMany({
      where: { marketId: market.marketId, id, status: 'active' },
      data: {
        status: 'released',
        releaseCause: cause,
        statusChangedAt: toDate(now),
        version: { increment: 1 },
      },
    });
    if (count === 0) return false;
    await this.prisma.tx(market).inventoryReservationLine.updateMany({
      where: { marketId: market.marketId, reservationId: id, state: 'active' },
      data: { state: 'released', stateChangedAt: toDate(now) },
    });
    return true;
  }

  async expireDue(
    market: MarketContext,
    ids: readonly Id<'Reservation'>[],
    now: Temporal.Instant,
  ): Promise<readonly Id<'Reservation'>[]> {
    if (ids.length === 0) return [];
    // The caller holds the stock locks; `status = 'active'` is the guard, so two runs of the job
    // change each row once (design 11).
    const changed: Id<'Reservation'>[] = [];
    for (const id of new Set(ids)) {
      const { count } = await this.prisma.tx(market).inventoryReservation.updateMany({
        where: { marketId: market.marketId, id, status: 'active', expiresAt: { lte: toDate(now) } },
        data: { status: 'expired', statusChangedAt: toDate(now), version: { increment: 1 } },
      });
      if (count === 1) changed.push(id);
    }
    if (changed.length > 0) {
      await this.prisma.tx(market).inventoryReservationLine.updateMany({
        where: { marketId: market.marketId, reservationId: { in: changed }, state: 'active' },
        data: { state: 'expired', stateChangedAt: toDate(now) },
      });
    }
    return changed;
  }

  async dueForExpiry(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly Reservation[]> {
    const rows = await this.prisma.tx(market).inventoryReservation.findMany({
      where: { marketId: market.marketId, status: 'active', expiresAt: { lte: toDate(now) } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      include: { lines: true },
    });
    return rows.map(toReservation);
  }

  async liveOnSellUnits(
    market: MarketContext,
    keys: readonly SellUnitRef[],
    now: Temporal.Instant,
  ): Promise<readonly Reservation[]> {
    if (keys.length === 0) return [];
    const wanted = new Set(keys.map((key) => `${key.offerId}/${key.variantId}`));
    const hits = await this.prisma.tx(market).inventoryReservationLine.findMany({
      where: {
        marketId: market.marketId,
        state: 'active',
        expiresAt: { gt: toDate(now) },
        offerId: { in: [...new Set(keys.map((key) => key.offerId))] },
        variantId: { in: [...new Set(keys.map((key) => key.variantId))] },
      },
      select: { reservationId: true, offerId: true, variantId: true },
    });
    const reservationIds = [
      ...new Set(
        hits
          .filter((hit) => wanted.has(`${hit.offerId}/${hit.variantId}`))
          .map((hit) => hit.reservationId),
      ),
    ];
    if (reservationIds.length === 0) return [];
    const rows = await this.prisma.tx(market).inventoryReservation.findMany({
      where: { marketId: market.marketId, id: { in: reservationIds }, status: 'active' },
      orderBy: { id: 'asc' },
      include: { lines: true },
    });
    return rows.map(toReservation);
  }
}
