import type { CategoryName, CategoryRow, StatusFilter } from './types.ts';

// The pure part of the category tree: names, which rows are visible for the open branches, the
// search and the status filter, and the keyboard model of a WAI-ARIA tree (ux.md 3.2a).

/** The name in `locale`, else the first locale in code order, else the slug. */
export function nameOf(row: CategoryRow, locale: string): string {
  return nameIn(row.names, locale) ?? row.slug;
}

export function nameIn(names: readonly CategoryName[], locale: string): string | null {
  const wanted = names.find((entry) => entry.locale === locale);
  const first = [...names].sort((a, b) => (a.locale < b.locale ? -1 : 1))[0];
  return (wanted ?? first)?.name ?? null;
}

/** The text direction of a locale's names: Persian and Arabic names read right to left. */
export function directionOf(locale: string): 'rtl' | 'ltr' {
  const language = locale.split('-')[0]?.toLowerCase() ?? '';
  return ['fa', 'ar', 'he', 'ur', 'ps', 'ckb', 'sd', 'ug', 'yi', 'dv'].includes(language)
    ? 'rtl'
    : 'ltr';
}

export interface TreeIndex {
  readonly byId: ReadonlyMap<string, CategoryRow>;
  readonly children: ReadonlyMap<string | null, readonly CategoryRow[]>;
}

export function indexOf(rows: readonly CategoryRow[]): TreeIndex {
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const children = new Map<string | null, CategoryRow[]>();
  for (const row of rows) {
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  return { byId, children };
}

export interface Filter {
  /** The search text, trimmed. */
  readonly q: string;
  readonly status: StatusFilter;
  /** A locale code: only categories with no name in it ("Missing: {language}"). */
  readonly missing?: string | null;
}

export const isFiltering = (filter: Filter): boolean =>
  filter.q !== '' || filter.status !== 'all' || (filter.missing ?? null) !== null;

/** How many categories lack a name in each locale (the tree's "Missing" counts). */
export function missingCounts(
  rows: readonly CategoryRow[],
  locales: readonly string[],
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    locales.map((locale) => [
      locale,
      rows.filter((row) => !row.names.some((entry) => entry.locale === locale)).length,
    ]),
  );
}

/** The ids of every category that has a child. */
export function branchIds(rows: readonly CategoryRow[]): ReadonlySet<string> {
  return new Set(rows.filter((row) => row.parentId !== null).map((row) => row.parentId as string));
}

export function matches(row: CategoryRow, filter: Filter): boolean {
  if (filter.status !== 'all' && row.status !== filter.status) return false;
  if (
    filter.missing !== undefined &&
    filter.missing !== null &&
    row.names.some((entry) => entry.locale === filter.missing)
  )
    return false;
  if (filter.q === '') return true;
  const needle = filter.q.toLocaleLowerCase();
  return (
    row.slug.toLocaleLowerCase().includes(needle) ||
    row.names.some((entry) => entry.name.toLocaleLowerCase().includes(needle))
  );
}

export interface VisibleRow {
  readonly row: CategoryRow;
  readonly hasChildren: boolean;
  /** Open branch: its children are listed after it. */
  readonly expanded: boolean;
  /** 1-based place among the siblings that are listed, and how many there are. */
  readonly posInSet: number;
  readonly setSize: number;
}

/**
 * The rows to list. Without a filter, a row is listed when every ancestor is expanded. With one,
 * the rows that match are listed with their ancestors, all open, and nothing else: a search finds
 * a category wherever it sits.
 */
export function visibleRows(
  rows: readonly CategoryRow[],
  expanded: ReadonlySet<string>,
  filter: Filter,
): readonly VisibleRow[] {
  const { byId, children } = indexOf(rows);
  let shown: Set<string> | null = null;
  if (isFiltering(filter)) {
    shown = new Set();
    for (const row of rows) {
      if (!matches(row, filter)) continue;
      let at: CategoryRow | undefined = row;
      while (at !== undefined && !shown.has(at.id)) {
        shown.add(at.id);
        at = at.parentId === null ? undefined : byId.get(at.parentId);
      }
    }
  }
  const out: VisibleRow[] = [];
  const walk = (parent: string | null): void => {
    const list = (children.get(parent) ?? []).filter((row) => shown === null || shown.has(row.id));
    list.forEach((row, index) => {
      const kids = (children.get(row.id) ?? []).filter((c) => shown === null || shown.has(c.id));
      const open = kids.length > 0 && (shown !== null || expanded.has(row.id));
      out.push({
        row,
        hasChildren: kids.length > 0,
        expanded: open,
        posInSet: index + 1,
        setSize: list.length,
      });
      if (open) walk(row.id);
    });
  };
  walk(null);
  return out;
}

export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End' | '*';

export type KeyResult =
  | { readonly kind: 'focus'; readonly id: string }
  | { readonly kind: 'expand'; readonly id: string }
  | { readonly kind: 'collapse'; readonly id: string }
  | { readonly kind: 'expand-siblings'; readonly id: string }
  | { readonly kind: 'none' };

/**
 * What a navigation key does on the focused row (WAI-ARIA tree): Down and Up move, Right opens a
 * closed branch and then moves to its first child, Left closes an open branch and then moves to the
 * parent, Home and End go to the first and last listed row, `*` opens every sibling.
 */
export function keyResult(list: readonly VisibleRow[], focusedId: string, key: TreeKey): KeyResult {
  const at = list.findIndex((entry) => entry.row.id === focusedId);
  if (at < 0) return { kind: 'none' };
  const current = list[at]!;
  const focus = (index: number): KeyResult => {
    const target = list[Math.min(Math.max(index, 0), list.length - 1)];
    return target === undefined || target.row.id === focusedId
      ? { kind: 'none' }
      : { kind: 'focus', id: target.row.id };
  };
  switch (key) {
    case 'ArrowDown':
      return focus(at + 1);
    case 'ArrowUp':
      return focus(at - 1);
    case 'Home':
      return focus(0);
    case 'End':
      return focus(list.length - 1);
    case 'ArrowRight':
      if (!current.hasChildren) return { kind: 'none' };
      return current.expanded ? focus(at + 1) : { kind: 'expand', id: focusedId };
    case 'ArrowLeft': {
      if (current.hasChildren && current.expanded) return { kind: 'collapse', id: focusedId };
      const parentId = current.row.parentId;
      return parentId === null
        ? { kind: 'none' }
        : focus(list.findIndex((entry) => entry.row.id === parentId));
    }
    case '*':
      return { kind: 'expand-siblings', id: focusedId };
  }
}

/** The next listed row after `focusedId` whose name starts with `typed` (type-ahead), wrapping. */
export function typeAhead(
  list: readonly VisibleRow[],
  focusedId: string,
  typed: string,
  locale: string,
): string | null {
  const at = list.findIndex((entry) => entry.row.id === focusedId);
  const needle = typed.toLocaleLowerCase();
  for (let step = 1; step <= list.length; step += 1) {
    const entry = list[(at + step) % list.length];
    if (entry !== undefined && nameOf(entry.row, locale).toLocaleLowerCase().startsWith(needle)) {
      return entry.row.id;
    }
  }
  return null;
}
