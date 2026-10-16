import type { CallContext, Id } from '@mondapac/shared-kernel';

// Display-only lookups for the held-price review (pricing design 5.2, mini-review 2026-10-16).
// Both ports are advisory: a failure or an absent key never fails the queue; the row shows null.

/** One (Offer, Variant) of a held record. */
export interface HeldUnitKey {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/** The published product name and Variant label of a held unit (seller text; escape it). */
export interface HeldUnitLabel {
  readonly productName: string;
  readonly variantLabel: string | null;
}

/** The map key of one (Offer, Variant) in the answer of {@link HeldUnitLabels}. */
export function heldUnitKey(key: HeldUnitKey): string {
  return `${key.offerId}:${key.variantId}`;
}

/**
 * catalog's `sellUnitLabels` seen from pricing: published content only. One batched call per
 * page, the caller's `CallContext` unchanged. Throws when catalog refuses or fails; an unknown
 * key and another Market's key are absent.
 */
export interface HeldUnitLabels {
  labelsOf(
    context: CallContext,
    keys: readonly HeldUnitKey[],
  ): Promise<ReadonlyMap<string, HeldUnitLabel>>;
}

export const HELD_UNIT_LABELS = Symbol('HELD_UNIT_LABELS');

/**
 * sellers' `sellerSummaries` seen from pricing: the public store name of the approved revision,
 * nothing else. Throws when sellers refuses or fails; a seller without an approved revision, an
 * unknown id and another Market's seller are absent.
 */
export interface SellerStoreNames {
  namesOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>>;
}

export const SELLER_STORE_NAMES = Symbol('SELLER_STORE_NAMES');
