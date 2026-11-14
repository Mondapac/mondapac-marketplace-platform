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
  const path = choice.path.length === 0 ? [choice.name] : choice.path;
  return [...path, ...(choice.general ? [generalLabel] : [])].join(SEPARATOR);
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
