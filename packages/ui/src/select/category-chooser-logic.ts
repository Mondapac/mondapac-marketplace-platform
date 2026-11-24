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
  /** The id of the choice's department, when the picker sends it (older payloads do not). */
  readonly departmentId?: string;
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

/**
 * The department of a choice: its id when the picker sends one, else the level 1 name (path[0]);
 * null when unknown. Limitation of the name fallback: two departments with the same name count as
 * one here. That only affects this client; the server compares real ancestor ids and is the
 * authority at submit.
 */
export function departmentOfChoice(choice: CategoryChoice | undefined): string | null {
  if (choice === undefined) return null;
  return choice.departmentId ?? choice.path[0] ?? null;
}

/**
 * Same-branch rule of a seller's product: the choices an Add control may offer. Without a primary
 * (or one the picker does not describe) nothing is restricted.
 */
export function choicesInBranch(
  choices: readonly CategoryChoice[],
  ids: readonly string[],
): readonly CategoryChoice[] {
  const primary = ids[0];
  const department =
    primary === undefined ? null : departmentOfChoice(choices.find((c) => c.id === primary));
  return department === null
    ? choices
    : choices.filter((choice) => departmentOfChoice(choice) === department);
}

/**
 * Drops the non-primary ids that are known to sit in another department than the primary. A
 * chosen id the picker does not describe is kept (the API still checks it at submit).
 */
export function dropOutOfBranch(
  ids: readonly string[],
  choices: readonly CategoryChoice[],
): { readonly ids: string[]; readonly dropped: number } {
  const byId = new Map(choices.map((choice) => [choice.id, choice]));
  const primary = ids[0];
  const department = primary === undefined ? null : departmentOfChoice(byId.get(primary));
  if (primary === undefined || department === null) return { ids: [...ids], dropped: 0 };
  const kept = ids.filter((id, index) => {
    if (index === 0) return true;
    const other = departmentOfChoice(byId.get(id));
    return other === null || other === department;
  });
  return { ids: kept, dropped: ids.length - kept.length };
}
