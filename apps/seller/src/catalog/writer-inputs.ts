import type { WriterDetail } from '@mondapac/ui';
import { pickLabel, type AttributeInput, type AttributeInputs } from './draft-content.ts';
import type { FormCategory, FormField } from './types.ts';

// What the form hands the "Write with AI" modal: the category label and the product details as
// the form shows them right now (unsaved edits included). Display text only; the server resolves
// nothing from these and sends no ids, images, prices or tags to the model.

/**
 * The primary category as its path (`Pantry › Rice and grains › Basmati rice`), or ''. The primary
 * category is the first one listed (the API freezes the feature set under `categoryIds[0]`), so
 * only that one is sent, never the next that happens to be known.
 */
export function writerCategory(
  categories: readonly FormCategory[],
  categoryIds: readonly string[],
  locale: string,
): string {
  const byId = new Map(categories.map((category) => [category.categoryId, category]));
  const first = categoryIds[0] === undefined ? undefined : byId.get(categoryIds[0]);
  const names: string[] = [];
  let current: FormCategory | undefined = first;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    names.unshift(pickLabel(current.names, locale, current.categoryId));
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return names.join(' › ');
}

function textOf(field: FormField, input: AttributeInput | undefined, locale: string): string {
  if (input === undefined) return '';
  const label = (code: string) =>
    pickLabel(field.options.find((option) => option.code === code)?.labels ?? {}, locale, code);
  if (typeof input === 'boolean') return input ? 'Yes' : '';
  if (typeof input === 'string') return field.options.length > 0 ? label(input) : input.trim();
  if (Array.isArray(input)) return (input as readonly string[]).map(label).join(', ');
  const map = input as Readonly<Record<string, string>>;
  if (typeof map['amount'] === 'string' && typeof map['unit'] === 'string') {
    return map['amount'].trim() === '' ? '' : `${map['amount'].trim()} ${map['unit']}`;
  }
  return (map[locale] ?? map[''] ?? Object.values(map)[0] ?? '').trim();
}

/** Every filled detail field as name and value; the modal clamps the list to the API's limits. */
export function writerDetails(
  fields: readonly FormField[],
  inputs: AttributeInputs,
  locale: string,
): WriterDetail[] {
  return fields.flatMap((field) => {
    const value = textOf(field, inputs[field.code], locale);
    return value === '' ? [] : [{ name: pickLabel(field.names, locale, field.code), value }];
  });
}
