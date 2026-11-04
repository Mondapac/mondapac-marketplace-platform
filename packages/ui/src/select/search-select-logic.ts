// The pure rules of the searchable select (single and multiple): matching, ordering, the active
// row and the selection cap. No React here, so the rules are tested without a browser.

export interface SearchSelectOption {
  readonly value: string;
  readonly label: string;
  /** A second line: a category's full path, an owner, a code. Searched as well. */
  readonly description?: string;
  readonly disabled?: boolean;
}

/** Lower case, accents and combining marks removed, so "café" is found by "cafe". */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();
}

/** Options whose label or description contains every word of the query. All for an empty query. */
export function filterOptions(
  options: readonly SearchSelectOption[],
  query: string,
): readonly SearchSelectOption[] {
  const words = normalizeForSearch(query).split(/\s+/u).filter(Boolean);
  if (words.length === 0) return options;
  return options.filter((option) => {
    const haystack = normalizeForSearch(`${option.label} ${option.description ?? ''}`);
    return words.every((word) => haystack.includes(word));
  });
}

/** The picked options first (in the order picked), then the rest in their own order. */
export function pickedFirst(
  options: readonly SearchSelectOption[],
  picked: readonly SearchSelectOption[],
): readonly SearchSelectOption[] {
  if (picked.length === 0) return options;
  const pickedValues = new Set(picked.map((option) => option.value));
  const top = picked.map((option) => options.find((o) => o.value === option.value) ?? option);
  return [...top, ...options.filter((option) => !pickedValues.has(option.value))];
}

/**
 * The row after moving `delta` steps from `from` (-1 for none yet), skipping disabled rows and
 * wrapping at the ends. -1 when no row can be active.
 */
export function moveActive(
  options: readonly SearchSelectOption[],
  from: number,
  delta: 1 | -1,
): number {
  const enabled = options.filter((option) => option.disabled !== true).length;
  if (enabled === 0) return -1;
  let index = from;
  for (let step = 0; step < options.length; step += 1) {
    index = (index + delta + options.length) % options.length;
    if (from === -1 && delta === -1 && step === 0) index = options.length - 1;
    if (options[index]?.disabled !== true) return index;
  }
  return -1;
}

/** The first and the last enabled row, for Home and End. */
export function edgeActive(options: readonly SearchSelectOption[], end: 'first' | 'last'): number {
  const indexes = options.flatMap((option, index) => (option.disabled === true ? [] : [index]));
  if (indexes.length === 0) return -1;
  return end === 'first' ? indexes[0]! : indexes[indexes.length - 1]!;
}

/** Whether another option may be picked under the cap (no cap when `max` is undefined). */
export function canPickMore(
  picked: readonly SearchSelectOption[],
  max: number | undefined,
): boolean {
  return max === undefined || picked.length < max;
}

/** The picks after toggling an option: removed when picked, added when under the cap, else same. */
export function togglePick(
  picked: readonly SearchSelectOption[],
  option: SearchSelectOption,
  max: number | undefined,
): readonly SearchSelectOption[] {
  if (picked.some((entry) => entry.value === option.value)) {
    return picked.filter((entry) => entry.value !== option.value);
  }
  return canPickMore(picked, max) ? [...picked, option] : picked;
}

/** Whether the search box shows: from `threshold` options, or always for a list that grows. */
export function showsSearch(input: {
  readonly optionCount: number;
  readonly threshold: number;
  readonly always: boolean;
  readonly server: boolean;
}): boolean {
  return input.always || input.server || input.optionCount >= input.threshold;
}
