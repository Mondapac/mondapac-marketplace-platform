import { pickLabel, type VariantRow } from './draft-content.ts';
import type { FormField } from './types.ts';

// The pure half of the variant grid editor (variants V3): which attributes a product varies on,
// which options are active on each, and which combinations of them are ticked. A ticked
// combination is a variant row; an unticked one has none.

/** The variant attributes of the feature set a product may vary on. */
export function axisCandidates(fields: readonly FormField[]): readonly FormField[] {
  return fields.filter((field) => field.isVariantOption && field.dataType === 'select');
}

/** The axis codes a saved draft names, else the candidates its variants already use, in feature set order. */
export function axesOf(
  content: Readonly<Record<string, unknown>> | undefined,
  rows: readonly VariantRow[],
  fields: readonly FormField[],
): string[] {
  const candidates = axisCandidates(fields).map((field) => field.code);
  const stored = content?.['variantAxes'];
  if (Array.isArray(stored)) {
    const named = stored.filter((item): item is string => typeof item === 'string');
    return candidates.filter((code) => named.includes(code));
  }
  // A draft written before axes were chosen varies on every candidate its variants use.
  const used = new Set(rows.flatMap((row) => Object.keys(row.options)));
  return candidates.filter((code) => used.has(code));
}

/** The active options per axis: those the rows already use, in the field's option order. */
export function activeOptionsOf(
  rows: readonly VariantRow[],
  axes: readonly string[],
): Record<string, string[]> {
  return Object.fromEntries(
    axes.map((axis) => [
      axis,
      [...new Set(rows.map((row) => row.options[axis]).filter((code): code is string => !!code))],
    ]),
  );
}

export interface Combination {
  /** Stable text for the combination: `axis=option` pairs in axis order. */
  readonly key: string;
  readonly options: Readonly<Record<string, string>>;
}

/** Every combination of the active options, in axis then option order of the feature set. */
export function combinationsOf(
  fields: readonly FormField[],
  axes: readonly string[],
  active: Readonly<Record<string, readonly string[]>>,
): Combination[] {
  let combos: Combination[] = [{ key: '', options: {} }];
  for (const axis of axes) {
    const field = fields.find((item) => item.code === axis);
    if (field === undefined) return [];
    const codes = field.options
      .map((option) => option.code)
      .filter((code) => (active[axis] ?? []).includes(code));
    combos = combos.flatMap((combo) =>
      codes.map((code) => ({
        key: `${combo.key}${combo.key === '' ? '' : ';'}${axis}=${code}`,
        options: { ...combo.options, [axis]: code },
      })),
    );
  }
  return axes.length === 0 ? [] : combos;
}

/** The row of a combination, or undefined when it is not ticked. */
export function rowOf(
  rows: readonly VariantRow[],
  combo: Combination,
  axes: readonly string[],
): VariantRow | undefined {
  return rows.find((row) => axes.every((axis) => row.options[axis] === combo.options[axis]));
}

/** `Large · Red`: the option labels of a combination, as the server builds a variant's label. */
export function combinationTitle(
  fields: readonly FormField[],
  axes: readonly string[],
  combo: Readonly<Record<string, string>>,
  locale: string,
): string {
  return axes
    .map((axis) => {
      const field = fields.find((item) => item.code === axis);
      const option = field?.options.find((item) => item.code === combo[axis]);
      return option === undefined
        ? (combo[axis] ?? '')
        : pickLabel(option.labels, locale, option.code);
    })
    .join(' · ');
}

/** The cap warning starts at nine tenths of the limit. */
export function nearLimit(count: number, max: number): boolean {
  return max > 0 && count >= Math.ceil(max * 0.9) && count < max;
}
