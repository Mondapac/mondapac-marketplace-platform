import type { AttributeSchema } from '@mondapac/shared-kernel';
import { axisFieldsOf } from './variant-axes';

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
  /** The axes the product varies on (V3); undefined: every option field of the family. */
  selectedAxes?: readonly string[],
): Record<string, string> {
  const axes = axisFieldsOf(schema.fields, selectedAxes);
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
