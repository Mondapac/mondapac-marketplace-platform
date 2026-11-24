import { CATEGORY_MAX, assignColorKeys, type ColorKey } from './chart-palette.ts';
import { splitTop } from './chart-scale.ts';

export interface CategoryInput {
  readonly id: string;
  readonly label: string;
  /** Gross, non-negative. */
  readonly value: number;
  /** The colour of this category; see chart-palette. Falls back to the next free slot by size. */
  readonly colorKey?: ColorKey;
}

export interface CategorySlice {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly share: number;
  readonly colorKey: ColorKey;
  readonly isOther: boolean;
}

/**
 * The `CATEGORY_MAX` largest categories by size, then everything else as one "Other" slice
 * (always cat-other). `dropped` counts values that are negative or not finite: they are left out,
 * never drawn. Zero is a valid value but has no slice.
 */
export function bucketCategories(
  items: readonly CategoryInput[],
  otherLabel: string,
): { readonly slices: CategorySlice[]; readonly dropped: number } {
  const dropped = items.filter((i) => !Number.isFinite(i.value) || i.value < 0).length;
  const { top, rest } = splitTop(
    items.map((i) => i.value),
    CATEGORY_MAX,
  );
  const total = [...top, ...rest].reduce((sum, i) => sum + items[i]!.value, 0);
  if (total <= 0) return { slices: [], dropped };
  const keys = assignColorKeys(top.map((i) => items[i]!.colorKey));
  const slices: CategorySlice[] = top.map((i, k) => ({
    id: items[i]!.id,
    label: items[i]!.label,
    value: items[i]!.value,
    share: items[i]!.value / total,
    colorKey: keys[k]!,
    isOther: false,
  }));
  if (rest.length > 0) {
    const other = rest.reduce((sum, i) => sum + items[i]!.value, 0);
    slices.push({
      id: '__other',
      label: otherLabel,
      value: other,
      share: other / total,
      colorKey: 'cat-other',
      isOther: true,
    });
  }
  return { slices, dropped };
}
