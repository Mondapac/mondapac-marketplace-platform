import type { AttributeField } from '@mondapac/shared-kernel';

/** The fields a product may vary on: the family's select attributes flagged as variant options. */
export function optionFieldsOf(fields: readonly AttributeField[]): AttributeField[] {
  return fields.filter((field) => field.isVariantOption && field.dataType === 'select');
}

/**
 * The axes a product varies on (variants V3, plan sections 4 and 10): the option fields the draft
 * selected, in the family's order. A draft that names no axes (`undefined`) varies on every option
 * field of its family, as before V3, so older drafts and files keep working. A selected code the
 * family has no option field for is left out here; the type handler reports it.
 */
export function axisFieldsOf(
  fields: readonly AttributeField[],
  selected: readonly string[] | undefined,
): AttributeField[] {
  const options = optionFieldsOf(fields);
  return selected === undefined
    ? options
    : options.filter((field) => selected.includes(field.code));
}

/**
 * The axis codes a working copy's `variantAxes` holds, or `undefined` when it names none. Anything
 * that is not a list of strings reads as none (the draft shape check refuses it at save).
 */
export function selectedAxesOf(content: Readonly<Record<string, unknown>>): string[] | undefined {
  const raw = content['variantAxes'];
  if (!Array.isArray(raw)) return undefined;
  return (raw as unknown[]).filter((code): code is string => typeof code === 'string');
}

/** The axis codes a frozen revision's variants vary on: the union of their option value keys. */
export function axesOfOptionValues(
  variants: readonly { readonly optionValues: Readonly<Record<string, string>> }[],
): string[] {
  return [...new Set(variants.flatMap((variant) => Object.keys(variant.optionValues)))].sort();
}
