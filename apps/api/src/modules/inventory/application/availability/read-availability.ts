import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_AVAILABILITY_BATCH,
  sellUnitKeyOf,
  type AvailabilityMap,
  type InventoryBatchTooLarge,
  type InventoryValidationFailed,
  type SellUnitAvailability,
  type SellUnitKey,
} from '../../contracts/inventory.facade';
import { sellableOfSellUnit } from '../../domain/stock';
import type { AvailabilitySignalRepository } from '../ports/availability-signal.repository';
import type { AvailabilityReader } from '../ports/availability-reader';

export interface AvailabilityInput {
  readonly keys: readonly { readonly offerId: string; readonly variantId: string }[];
}

export type AvailabilityFailure = InventoryValidationFailed | InventoryBatchTooLarge;

export interface AvailabilityDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly items: AvailabilityReader;
  readonly signals: AvailabilitySignalRepository;
}

/**
 * The read shared by the pair: the sellable count (the largest sellable of the non-retired
 * sources, design 4.1 and Q10) and the stored public status. Checked whole before any read, one
 * read-only unit. A sell unit with no stock is present as `out`, which is the fail-closed answer.
 */
export async function readAvailability(
  deps: AvailabilityDependencies,
  context: CallContext,
  input: AvailabilityInput,
): Promise<Result<AvailabilityMap, AvailabilityFailure>> {
  if (!Array.isArray(input?.keys)) {
    return err({ code: 'validation.failed', fields: [{ path: 'keys', code: 'type' }] });
  }
  if (input.keys.length > MAX_AVAILABILITY_BATCH) return err({ code: 'batch.too-large' });
  const keys = new Map<string, SellUnitKey>();
  for (const raw of input.keys as readonly unknown[]) {
    const entry = raw as { offerId?: unknown; variantId?: unknown } | null;
    const offerId = typeof entry?.offerId === 'string' ? parseId<'Offer'>(entry.offerId) : null;
    const variantId =
      typeof entry?.variantId === 'string' ? parseId<'Variant'>(entry.variantId) : null;
    if (offerId === null || !offerId.ok || variantId === null || !variantId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'keys', code: 'format' }] });
    }
    const key = { offerId: offerId.value, variantId: variantId.value };
    keys.set(sellUnitKeyOf(key), key);
  }
  if (keys.size === 0) return ok(new Map());
  const { market } = context;
  return deps.unitOfWork.run<AvailabilityMap, AvailabilityFailure>(
    market,
    async () => {
      const items = await deps.items.itemsOfSellUnits(market, [...keys.values()]);
      const answer = new Map<string, SellUnitAvailability>();
      for (const [mapKey, key] of keys) {
        const mine = items
          .filter((item) => item.offerId === key.offerId && item.variantId === key.variantId)
          .map((item) => ({ onHand: item.onHand, held: item.held, retired: false }));
        const sellable = sellableOfSellUnit(mine);
        if (sellable === 0) {
          answer.set(mapKey, { sellable: 0, status: 'out', onlyLeft: null });
          continue;
        }
        const signal = await deps.signals.find(market, key.offerId, key.variantId);
        const status = signal?.status === 'low' ? 'low' : 'in-stock';
        answer.set(mapKey, {
          sellable,
          status,
          onlyLeft: status === 'low' ? sellable : null,
        });
      }
      return ok(answer);
    },
    { readOnly: true },
  );
}
