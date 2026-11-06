import type { AttributeSchema } from '@mondapac/shared-kernel';

/** Separates the option labels of a variant's axes: `Large · Red`. */
export const VARIANT_LABEL_SEPARATOR = ' · ';

/**
 * The automatic label of a variant per locale (variants V2, decision t12): the labels of its option
 * values, one per axis in the family's order, joined by {@link VARIANT_LABEL_SEPARATOR}. A seller
 * never types a label. A locale in which any axis option has no label gets no label at all (nothing
 * is machine-translated or borrowed from another language), so the language-publish gate counts the
 * variant as incomplete in that locale. Pure: the same schema and options give the same labels.
 */
export function buildVariantLabels(
  schema: AttributeSchema,
  optionValues: Readonly<Record<string, string>>,
  locales: readonly string[],
): Record<string, string> {
  const axes = schema.fields.filter(
    (field) => field.isVariantOption && field.dataType === 'select',
  );
  const labels: Record<string, string> = {};
  if (axes.length === 0) return labels;
  for (const locale of locales) {
    const parts: string[] = [];
    for (const axis of axes) {
      const chosen = Object.hasOwn(optionValues, axis.code) ? optionValues[axis.code] : undefined;
      const option = (axis.bounds.options ?? []).find((candidate) => candidate.code === chosen);
      const text =
        option?.labels !== undefined && Object.hasOwn(option.labels, locale)
          ? option.labels[locale]
          : undefined;
      if (text === undefined || text.trim().length === 0) break;
      parts.push(text.trim());
    }
    if (parts.length === axes.length) labels[locale] = parts.join(VARIANT_LABEL_SEPARATOR);
  }
  return labels;
}

/** One locale in which a stored variant label is not the automatic one. */
export interface LabelDifference {
  readonly locale: string;
  /** The label stored on the revision; null when the revision has none in this locale. */
  readonly stored: string | null;
  /** The label the builder gives now; null when it gives none (an option label is missing). */
  readonly built: string | null;
}

/**
 * The locales in which the stored labels of a variant differ from the built ones, in locale
 * order (the "Custom variant labels" report, variants V2). A locale where both are absent is not a
 * difference. Pure.
 */
export function differingLabels(
  stored: Readonly<Record<string, string>>,
  built: Readonly<Record<string, string>>,
  locales: readonly string[],
): LabelDifference[] {
  const out: LabelDifference[] = [];
  for (const locale of [...locales].sort()) {
    const s = Object.hasOwn(stored, locale) ? stored[locale]! : null;
    const b = Object.hasOwn(built, locale) ? built[locale]! : null;
    if (s !== b) out.push({ locale, stored: s, built: b });
  }
  return out;
}
