import type { SellUnitView } from './types.ts';

// The pure half of the SKU and Selling columns (variants V5): the fallback SKU, the shape check and
// the single sell-units write a save has to send.

/** 1 to 64 printable ASCII characters, no space: the API's rule for a variant SKU. */
const SKU_SHAPE = /^[!-~]{1,64}$/;

/** The text a SKU field holds, trimmed; an empty text clears the SKU. */
export const skuTextOf = (draft: string): string => draft.trim();

export const isValidSku = (text: string): boolean => SKU_SHAPE.test(text);

/**
 * The SKU exports and invoices use when the unit has none: the offer SKU and the variant number,
 * not padded (`ABC-2`), as the API's `sellUnitDisplaySku` builds it.
 */
export function fallbackSku(sellerSku: string, variantNo: number): string {
  return `${sellerSku}-${variantNo}`;
}

/** The text a SKU field shows while empty: what exports show for this unit when it has no SKU. */
export function skuPlaceholder(unit: SellUnitView, sellerSku: string): string {
  return unit.variantSku === null ? unit.displaySku : fallbackSku(sellerSku, unit.variantNo);
}

/** One requested change as the route takes it; a field left out keeps its value. */
export interface UnitChange {
  readonly variantId: string;
  readonly variantSku?: string | null;
  readonly selling?: boolean;
}

export interface UnitPlan {
  readonly changes: UnitChange[];
  /** Variants whose SKU text is not a valid SKU. */
  readonly badSku: string[];
  /** Variants whose SKU is typed on another row of the table too. */
  readonly duplicateSku: string[];
  /** True when the draft would leave no unit selling. */
  readonly noneSelling: boolean;
}

/** The units a plan is made for: a row of the table that has a unit. */
export interface UnitRow {
  readonly variantId: string;
  readonly unit: SellUnitView;
}

/**
 * The changes of a save: a SKU or switch draft that differs from what the page loaded. Only
 * changed units are returned, as the route expects. A draft SKU is trimmed and an empty one clears
 * the SKU. Nothing is sent when `badSku`, `duplicateSku` or `noneSelling` is set.
 */
export function unitPlanOf(
  rows: readonly UnitRow[],
  skuDrafts: Readonly<Record<string, string>>,
  sellingDrafts: Readonly<Record<string, boolean>>,
): UnitPlan {
  const changes: UnitChange[] = [];
  const badSku: string[] = [];
  const typed = new Map<string, { variantId: string; edited: boolean }[]>();
  let sellingChanged = false;
  let anySelling = false;
  for (const { variantId, unit } of rows) {
    const draftSku = skuDrafts[variantId];
    const draftSelling = sellingDrafts[variantId];
    const text = draftSku === undefined ? (unit.variantSku ?? '') : skuTextOf(draftSku);
    const edited = draftSku !== undefined && text !== (unit.variantSku ?? '');
    const change: { variantId: string; variantSku?: string | null; selling?: boolean } = {
      variantId,
    };
    if (draftSelling ?? unit.selling) anySelling = true;
    if (edited) {
      if (text !== '' && !isValidSku(text)) badSku.push(variantId);
      else change.variantSku = text === '' ? null : text;
    }
    if (draftSelling !== undefined && draftSelling !== unit.selling) {
      change.selling = draftSelling;
      sellingChanged = true;
    }
    if (text !== '') typed.set(text, [...(typed.get(text) ?? []), { variantId, edited }]);
    if (change.variantSku !== undefined || change.selling !== undefined) changes.push(change);
  }
  // The same SKU on two rows is refused here when one of them was typed just now.
  const duplicateSku = [...typed.values()]
    .filter((group) => group.length > 1 && group.some((entry) => entry.edited))
    .flatMap((group) => group.map((entry) => entry.variantId));
  return {
    changes,
    badSku,
    duplicateSku,
    noneSelling: sellingChanged && rows.length > 0 && !anySelling,
  };
}

/** True when the unit would be the last one still selling if it were switched off. */
export function isLastSelling(
  rows: readonly UnitRow[],
  sellingDrafts: Readonly<Record<string, boolean>>,
  variantId: string,
): boolean {
  const on = rows.filter(({ variantId: id, unit }) => sellingDrafts[id] ?? unit.selling);
  return on.length === 1 && on[0]?.variantId === variantId;
}
