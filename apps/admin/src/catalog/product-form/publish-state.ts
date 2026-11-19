import type { AttributeInput, AttributeInputs } from './draft-content.ts';
import type { FormField } from './types.ts';

/** What a draft still lacks before it can be published, in the order the page shows it. */
export type Blocker = 'title' | 'category' | 'tax' | 'details';

function filled(value: AttributeInput | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  return Object.values(value as Record<string, string>).some((text) => text.trim() !== '');
}

/**
 * The gaps the form can see: a title, a category, a tax category and every required detail. The
 * server stays the authority (its not-ready list is shown when it refuses); this only keeps
 * Publish off, and names the gaps, until the page itself is complete.
 */
export function blockersOf(input: {
  readonly name: string;
  readonly categoryIds: readonly string[];
  readonly taxCategoryCode: string;
  readonly fields: readonly FormField[];
  readonly inputs: AttributeInputs;
}): Blocker[] {
  const list: Blocker[] = [];
  if (input.name.trim() === '') list.push('title');
  if (input.categoryIds.length === 0) list.push('category');
  if (input.taxCategoryCode === '') list.push('tax');
  if (input.fields.some((field) => field.required && !filled(input.inputs[field.code]))) {
    list.push('details');
  }
  return list;
}

/** "a, b and c" for the "To publish:" line. */
export function listOf(items: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}
