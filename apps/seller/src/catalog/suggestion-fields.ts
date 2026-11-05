import { pickLabel } from './draft-content.ts';
import type { ProductView } from './types.ts';

/** A select field of a product that takes a suggestion, as the Value suggestions form shows it. */
export interface SuggestableField {
  readonly code: string;
  readonly label: string;
  /** The values the field already offers, so the seller can see what is there. */
  readonly values: readonly string[];
}

/** A product a seller may still suggest on (the API's rule; it decides again). */
export const SUGGESTING_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'unpublished',
  'published',
]);

/**
 * The select fields of a product that take a suggestion: select or multi-select and not a variant
 * option (attributes A5). A Material field is not marked in the form; the API refuses it with
 * `attribute.not-suggestable`, which the form says in words.
 */
export function suggestableFields(product: ProductView, locale: string): SuggestableField[] {
  return product.form.fields
    .filter(
      (field) =>
        (field.dataType === 'select' || field.dataType === 'multi-select') &&
        !field.isVariantOption,
    )
    .map((field) => ({
      code: field.code,
      label: pickLabel(field.names, locale, field.code),
      values: field.options.map((option) => pickLabel(option.labels, locale, option.code)),
    }));
}

/** The draft name of a product in `locale`, read defensively; null when it has none. */
export function productDraftName(product: ProductView, locale: string): string | null {
  const texts = product.workingCopy?.content['texts'];
  if (typeof texts !== 'object' || texts === null) return null;
  const entry = (texts as Record<string, unknown>)[locale];
  if (typeof entry !== 'object' || entry === null) return null;
  const name = (entry as Record<string, unknown>)['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}
