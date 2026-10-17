import { Logger } from '@nestjs/common';
import type { CallContext } from '@mondapac/shared-kernel';
import { heldUnitKey, type HeldUnitLabels, type SellerStoreNames } from './ports/held-labels';
import type { PendingHoldView } from './ports/price-series.repository';

/** A held record with the display names a reviewer reads. All three are null when unknown. */
export interface LabelledHold extends PendingHoldView {
  readonly productName: string | null;
  readonly variantLabel: string | null;
  readonly storeName: string | null;
}

export interface HoldLabelDependencies {
  readonly unitLabels: HeldUnitLabels;
  readonly storeNames: SellerStoreNames;
}

const logger = new Logger('HoldLabels');

/**
 * Adds the product name, Variant label and public store name to a page of held records: ONE
 * batched call per facade, with distinct keys, in parallel, after the read unit has closed (no
 * facade call inside a unit). The caller's `CallContext` goes through unchanged; the Market is
 * only the context's. A failed lookup is logged (no names) and leaves its fields null: it never
 * fails the queue.
 */
export async function withHoldLabels(
  deps: HoldLabelDependencies,
  context: CallContext,
  holds: readonly PendingHoldView[],
): Promise<readonly LabelledHold[]> {
  if (holds.length === 0) return [];
  const keys = new Map(
    holds.map((h) => [heldUnitKey(h), { offerId: h.offerId, variantId: h.variantId } as const]),
  );
  const sellerIds = [...new Set(holds.map((h) => h.sellerId))];
  const [units, stores] = await Promise.allSettled([
    deps.unitLabels.labelsOf(context, [...keys.values()]),
    deps.storeNames.namesOf(context, sellerIds),
  ]);
  for (const [lookup, outcome] of [
    ['unit-labels', units],
    ['store-names', stores],
  ] as const) {
    if (outcome.status === 'rejected') {
      logger.warn({
        msg: 'pricing.hold-labels.lookup-failed',
        lookup,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    }
  }
  return holds.map((hold) => {
    const unit = units.status === 'fulfilled' ? units.value.get(heldUnitKey(hold)) : undefined;
    const storeName = stores.status === 'fulfilled' ? stores.value.get(hold.sellerId) : undefined;
    return {
      ...hold,
      productName: unit?.productName ?? null,
      variantLabel: unit?.variantLabel ?? null,
      storeName: storeName ?? null,
    };
  });
}
