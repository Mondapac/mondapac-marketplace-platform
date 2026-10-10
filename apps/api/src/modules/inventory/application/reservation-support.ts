import type {
  CallContext,
  Id,
  IdGenerator,
  MarketContext,
  Temporal,
} from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import { SellableCalculator } from '../domain/sellable-calculator';
import { availabilityOf } from '../domain/stock';
import type { AvailabilitySignalRepository } from './ports/availability-signal.repository';
import type { InventoryPolicyProvider } from './ports/inventory-policy-provider';
import type { ReservationRepository, SellUnitRef } from './ports/reservation.repository';
import type { SellerInventoryRepository } from './ports/seller-inventory.repository';
import type { StockItemRow } from './ports/stock.repository';
import { writeSignal } from './signal-writer';

/** Everything a unit that changes a sell unit's sellable needs to publish its signal (design 5.3). */
export interface SignalRecomputeDependencies {
  readonly reservations: ReservationRepository;
  readonly inventories: SellerInventoryRepository;
  readonly policies: InventoryPolicyProvider;
  readonly signals: AvailabilitySignalRepository;
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
}

export const sellUnitKey = (unit: SellUnitRef): string => `${unit.offerId}/${unit.variantId}`;

/** The distinct sell units of the refs in a stable order (offer, then variant). */
export function distinctSellUnits(refs: readonly SellUnitRef[]): SellUnitRef[] {
  const byKey = new Map<string, SellUnitRef>();
  for (const ref of refs)
    byKey.set(sellUnitKey(ref), { offerId: ref.offerId, variantId: ref.variantId });
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, unit]) => unit);
}

/**
 * Recomputes the public signal of each sell unit under the unit's stock lock (design 5.3, lock
 * rule L3). `locked` holds every item of the sell units, all sources; the held sums are read in a
 * new statement, so they include this unit's own writes. The seller's threshold overrides the
 * Market default. A sell unit with no item row is skipped: it has no seller to publish for.
 */
export async function recomputeSellUnitSignals(
  deps: SignalRecomputeDependencies,
  context: CallContext,
  market: MarketContext,
  locked: readonly StockItemRow[],
  sellUnits: readonly SellUnitRef[],
  now: Temporal.Instant,
): Promise<void> {
  if (sellUnits.length === 0) return;
  const held = await deps.reservations.heldQuantities(
    market,
    locked.map((item) => item.id),
    now,
  );
  const thresholds = new Map<Id<'Seller'>, number>();
  const thresholdOf = async (sellerId: Id<'Seller'>): Promise<number> => {
    const cached = thresholds.get(sellerId);
    if (cached !== undefined) return cached;
    const inventory = await deps.inventories.findBySeller(market, sellerId);
    const value =
      inventory?.state.lowStockThreshold ?? deps.policies.defaultLowStockThreshold(market);
    thresholds.set(sellerId, value);
    return value;
  };
  for (const unit of distinctSellUnits(sellUnits)) {
    const items = locked.filter(
      (item) => item.offerId === unit.offerId && item.variantId === unit.variantId,
    );
    if (items.length === 0) continue;
    const sellerId = items[0]!.sellerId;
    const sellable = SellableCalculator.ofSellUnit(
      items.map((item) => ({
        onHand: item.onHand,
        held: held.get(item.id) ?? 0,
        retired: item.retired,
      })),
    );
    await writeSignal(deps, context, market, {
      offerId: unit.offerId,
      variantId: unit.variantId,
      sellerId,
      next: availabilityOf(sellable, await thresholdOf(sellerId)),
      now,
    });
  }
}

/**
 * The lock set of a reservation unit (lock rule L1): every non-retired item of the sell units,
 * plus the items the reservations already hold lines on (retired ones too: their lines still
 * count). Returns the locked rows, the items of each sell unit among them.
 */
export async function lockSellUnitsOf(
  reservations: ReservationRepository,
  market: MarketContext,
  sellUnits: readonly SellUnitRef[],
  extraItemIds: readonly Id<'StockItem'>[],
): Promise<{ readonly all: readonly StockItemRow[]; readonly known: readonly StockItemRow[] }> {
  const known = await reservations.itemsOfSellUnits(market, sellUnits);
  const ids = new Set<Id<'StockItem'>>(extraItemIds);
  for (const item of known) if (!item.retired) ids.add(item.id);
  const all = await reservations.lockItems(market, [...ids]);
  return { all, known };
}
