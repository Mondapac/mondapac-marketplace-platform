import type { CallContext, Id } from '@mondapac/shared-kernel';

/** The published product name and Variant label of one sell unit (seller text; escape it). */
export interface SellUnitLabel {
  readonly productName: string;
  readonly variantLabel: string | null;
}

/**
 * catalog's `sellUnitLabels` seen from inventory, for display only. The answer is keyed
 * `offerId:variantId`; an unpublished, unknown or another Market's sell unit is absent. Throws
 * when catalog refuses or fails; the caller shows no names, never fails the read.
 */
export interface SellUnitLabelsSource {
  labelsOf(
    context: CallContext,
    keys: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[],
  ): Promise<ReadonlyMap<string, SellUnitLabel>>;
}

export const SELL_UNIT_LABELS_SOURCE = Symbol('SELL_UNIT_LABELS_SOURCE');
