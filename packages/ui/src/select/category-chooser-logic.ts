// The pure rules of the product category chooser (categories package C5b): the list a product
// files itself under, up to three, the first one primary. No React here, so the rules are tested
// without a browser. The API checks every rule again at submit.

/** One choice of the category picker (`GET .../category-picker` -> `choices`). */
export interface CategoryChoice {
  readonly id: string;
  readonly level: number;
  readonly name: string;
  /** The names from the department down to the choice. */
  readonly path: readonly string[];
  /** The level-3 node itself, offered after its children: the product sits on it directly. */
  readonly general: boolean;
  readonly status: 'active' | 'hidden';
}

/** The most categories one product may have (the API's MAX_PRODUCT_CATEGORIES). */
export const MAX_PRODUCT_CATEGORIES = 3;

const SEPARATOR = ' › ';

/** `Pantry › Rice › Basmati`; a general choice ends in the word for it: `Pantry › Rice › General`. */
export function choiceLabel(choice: CategoryChoice, generalLabel: string): string {
  return choiceParts(choice, generalLabel).join(SEPARATOR);
}

/** The names of `choiceLabel`, one by one (the chosen list shows the separators apart). */
export function choiceParts(choice: CategoryChoice, generalLabel: string): string[] {
  const path = choice.path.length === 0 ? [choice.name] : choice.path;
  return [...path, ...(choice.general ? [generalLabel] : [])];
}

/** Splits a label made with the separator back into its names. */
export function splitLabel(label: string): string[] {
  return label.split(SEPARATOR);
}

/** Which control gets focus after the list changed (null: leave focus alone). */
export type FocusTarget =
  | { readonly kind: 'row'; readonly id: string }
  | { readonly kind: 'add' }
  | { readonly kind: 'limit' };

/** After Remove: the next row's Remove button, else the previous one, else the Add control. */
export function focusAfterRemove(ids: readonly string[], id: string): FocusTarget {
  const index = ids.indexOf(id);
  const next = ids[index + 1] ?? ids[index - 1];
  return next === undefined || index < 0 ? { kind: 'add' } : { kind: 'row', id: next };
}

/** The first id is the primary category: another one is moved to the front, the rest keep order. */
export function makePrimary(ids: readonly string[], id: string): string[] {
  if (!ids.includes(id)) return [...ids];
  return [id, ...ids.filter((other) => other !== id)];
}

export function removeCategory(ids: readonly string[], id: string): string[] {
  return ids.filter((other) => other !== id);
}

/** Adds at the end; a duplicate or a fourth category is ignored. */
export function addCategory(
  ids: readonly string[],
  id: string,
  max: number = MAX_PRODUCT_CATEGORIES,
): string[] {
  if (ids.includes(id) || ids.length >= max) return [...ids];
  return [...ids, id];
}
