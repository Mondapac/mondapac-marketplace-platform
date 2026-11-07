/**
 * The per-sell-unit record of an Offer (variants V5; plan decisions t4 and t14): an optional
 * variant SKU and the reversible `selling` switch. Pure rules, no store: the use case reads the
 * rows, applies {@link applySellUnitChanges} and writes the result.
 */

/** The same shape as an Offer SKU: 1 to 64 printable ASCII characters, no space. */
const VARIANT_SKU_PATTERN = /^[!-~]{1,64}$/;

export function isValidVariantSku(value: unknown): value is string {
  return typeof value === 'string' && VARIANT_SKU_PATTERN.test(value);
}

/** One stored row, or the default of a variant that has none (selling, no variant SKU). */
export interface SellUnitState {
  readonly variantId: string;
  readonly variantSku: string | null;
  readonly selling: boolean;
}

/** One requested change; `variantSku` and `selling` are each left out to keep the stored value. */
export interface SellUnitChange {
  readonly variantId: string;
  /** A SKU, or null to clear it. */
  readonly variantSku?: string | null;
  readonly selling?: boolean;
}

export type SellUnitRefusal =
  | { readonly code: 'sell-unit.variant-unknown'; readonly variantId: string }
  | { readonly code: 'sell-unit.sku-invalid'; readonly variantId: string }
  | { readonly code: 'sell-unit.sku-duplicate'; readonly variantId: string }
  | { readonly code: 'sell-unit.none-selling' };

export interface SellUnitOutcome {
  /** The state of every non-retired variant of the product after the changes. */
  readonly after: readonly SellUnitState[];
  /** Only the variants whose state differs from before (to be written). */
  readonly changed: readonly SellUnitState[];
}

/**
 * Applies a batch of changes to the sell units of an Offer. `current` is the non-retired variants
 * of the Offer's product with their stored state (or the default). Rules: a change names a variant
 * of the product, once; a SKU has the Offer-SKU shape and is not used twice in the result; and at
 * least one unit keeps selling (an Offer with nothing on sale cannot be listed, t14).
 */
export function applySellUnitChanges(
  current: readonly SellUnitState[],
  changes: readonly SellUnitChange[],
):
  | { readonly ok: true; readonly value: SellUnitOutcome }
  | { readonly ok: false; readonly error: SellUnitRefusal } {
  const byId = new Map(current.map((unit) => [unit.variantId, unit] as const));
  const next = new Map(byId);
  const seen = new Set<string>();
  for (const change of changes) {
    const unit = byId.get(change.variantId);
    if (unit === undefined || seen.has(change.variantId)) {
      return {
        ok: false,
        error: { code: 'sell-unit.variant-unknown', variantId: change.variantId },
      };
    }
    seen.add(change.variantId);
    if (
      change.variantSku !== undefined &&
      change.variantSku !== null &&
      !isValidVariantSku(change.variantSku)
    ) {
      return { ok: false, error: { code: 'sell-unit.sku-invalid', variantId: change.variantId } };
    }
    next.set(change.variantId, {
      variantId: unit.variantId,
      variantSku: change.variantSku === undefined ? unit.variantSku : change.variantSku,
      selling: change.selling === undefined ? unit.selling : change.selling,
    });
  }
  const skus = new Set<string>();
  for (const unit of next.values()) {
    if (unit.variantSku === null) continue;
    if (skus.has(unit.variantSku)) {
      return { ok: false, error: { code: 'sell-unit.sku-duplicate', variantId: unit.variantId } };
    }
    skus.add(unit.variantSku);
  }
  const after = current.map((unit) => next.get(unit.variantId)!);
  if (!after.some((unit) => unit.selling)) {
    return { ok: false, error: { code: 'sell-unit.none-selling' } };
  }
  const changed = after.filter((unit, index) => {
    const before = current[index]!;
    return unit.variantSku !== before.variantSku || unit.selling !== before.selling;
  });
  return { ok: true, value: { after, changed } };
}

/**
 * The SKU shown on an export or an invoice line: the variant SKU when the seller set one, else
 * `{sellerSku}-{variantNo}`.
 */
export function sellUnitDisplaySku(input: {
  readonly sellerSku: string;
  readonly variantSku: string | null;
  readonly variantNo: number;
}): string {
  return input.variantSku ?? `${input.sellerSku}-${input.variantNo}`;
}
