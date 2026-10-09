import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_PRICE_BATCH,
  priceKeyOf,
  type EffectivePrice,
  type EffectivePriceMap,
  type PriceKey,
  type PricingBatchTooLarge,
  type PricingValidationFailed,
} from '../../contracts/pricing.facade';
import { effectiveRegular } from '../../domain/price-series';
import type { PriceSeriesRepository } from '../ports/price-series.repository';

export interface EffectivePricesInput {
  readonly keys: readonly { readonly offerId: string; readonly variantId: string }[];
}

export type EffectivePricesFailure = PricingValidationFailed | PricingBatchTooLarge;

export interface EffectivePricesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  readonly clock: Clock;
}

/**
 * Reads the regular price in force for up to 200 (Offer, Variant) keys in one read-only unit.
 * Shared by the pair below. A key with no series, a retired series or no price in force yet is
 * absent from the answer. Cost and holds never appear (ADR-0024).
 */
export async function readEffectivePrices(
  deps: EffectivePricesDependencies,
  context: CallContext,
  input: EffectivePricesInput,
): Promise<Result<EffectivePriceMap, EffectivePricesFailure>> {
  if (!Array.isArray(input?.keys)) {
    return err({ code: 'validation.failed', fields: [{ path: 'keys', code: 'type' }] });
  }
  if (input.keys.length > MAX_PRICE_BATCH) return err({ code: 'batch.too-large' });
  const keys = new Map<string, PriceKey>();
  for (const raw of input.keys as readonly unknown[]) {
    const entry = raw as { offerId?: unknown; variantId?: unknown } | null;
    const offerId = typeof entry?.offerId === 'string' ? parseId<'Offer'>(entry.offerId) : null;
    const variantId =
      typeof entry?.variantId === 'string' ? parseId<'Variant'>(entry.variantId) : null;
    if (offerId === null || !offerId.ok || variantId === null || !variantId.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'keys', code: 'format' }] });
    }
    const key = { offerId: offerId.value, variantId: variantId.value };
    keys.set(priceKeyOf(key), key);
  }
  if (keys.size === 0) return ok(new Map());
  const now = deps.clock.now();
  return deps.unitOfWork.run<EffectivePriceMap, EffectivePricesFailure>(
    context.market,
    async () => {
      const found = new Map<string, EffectivePrice>();
      for (const [mapKey, key] of keys) {
        const series = await deps.series.findByKey(context.market, key);
        if (series === null) continue;
        const record = effectiveRegular(series.state, now);
        if (record === null) continue;
        found.set(mapKey, {
          price: record.amount,
          taxInclusive: record.taxInclusive,
          recordId: record.id,
        });
      }
      return ok(found);
    },
    { readOnly: true },
  );
}
