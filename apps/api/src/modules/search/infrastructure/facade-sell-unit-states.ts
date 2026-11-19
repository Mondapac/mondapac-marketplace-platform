import type { CallContext } from '@mondapac/shared-kernel';
import { MAX_AVAILABILITY_BATCH, type InventoryFacade } from '../../inventory';
import { MAX_PRICE_BATCH, type PricingFacade } from '../../pricing';
import {
  sellUnitRefKey,
  type SellUnitRef,
  type SellUnitState,
  type SellUnitStates,
} from '../application/ports/sell-unit-states';

const BATCH = Math.min(MAX_AVAILABILITY_BATCH, MAX_PRICE_BATCH);

/**
 * {@link SellUnitStates} over inventory's `availability` and pricing's `effectivePrices`, in
 * batches the facades accept. Only the public status passes (never `sellable`, the exact count),
 * and only the buyer price (never Cost). Any refusal or failure is `null`.
 */
export class FacadeSellUnitStates implements SellUnitStates {
  constructor(
    private readonly inventory: InventoryFacade,
    private readonly pricing: PricingFacade,
  ) {}

  async states(
    context: CallContext,
    units: readonly SellUnitRef[],
  ): Promise<ReadonlyMap<string, SellUnitState> | null> {
    const result = new Map<string, SellUnitState>();
    const unique = [...new Map(units.map((unit) => [sellUnitRefKey(unit), unit])).values()];
    try {
      for (let at = 0; at < unique.length; at += BATCH) {
        const batch = unique.slice(at, at + BATCH);
        const [stock, prices] = await Promise.all([
          this.inventory.availability(context, batch),
          this.pricing.effectivePrices(context, batch),
        ]);
        if (!stock.ok || !prices.ok) return null;
        for (const unit of batch) {
          const key = sellUnitRefKey(unit);
          const status = stock.value.get(key)?.status;
          const price = prices.value.get(key)?.price ?? null;
          result.set(key, {
            inStock: status === 'in-stock' || status === 'low',
            price: price === null ? null : { amount: price.amount, currency: price.currency },
          });
        }
      }
      return result;
    } catch {
      return null;
    }
  }
}
