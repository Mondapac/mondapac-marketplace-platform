import { indexOf, nameOf } from './tree-model.ts';
import type { CategoryRow } from './types.ts';

// The pure part of Move, Merge and Archive (categories C4b): the reason rule and the targets a
// category may be moved or merged to. The API checks every rule again; this only keeps the
// obviously wrong choices out of the picker.

export const REASON_MIN = 10;
export const REASON_MAX = 500;
/** The target value of "Top level (department)". */
export const TOP = 'top';

export type RestructureKind = 'move' | 'merge' | 'archive';

/** The reason as it is sent: without the spaces around it. Its length is what the rule counts. */
export const reasonOf = (text: string): string => text.trim();

export type ReasonState = 'ok' | 'short' | 'long';
export function checkReason(text: string): ReasonState {
  const length = reasonOf(text).length;
  return length < REASON_MIN ? 'short' : length > REASON_MAX ? 'long' : 'ok';
}

/** The id of the category and of everything below it. */
export function subtreeIds(rows: readonly CategoryRow[], id: string): ReadonlySet<string> {
  const { children } = indexOf(rows);
  const out = new Set<string>([id]);
  const walk = (parent: string): void => {
    for (const child of children.get(parent) ?? []) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** The categories a target may be: not the category itself or anything below it, not merged or archived. */
export function targetRows(rows: readonly CategoryRow[], id: string): readonly CategoryRow[] {
  const excluded = subtreeIds(rows, id);
  return rows.filter(
    (row) => !excluded.has(row.id) && (row.status === 'active' || row.status === 'hidden'),
  );
}

/** Targets that match the typed words (name in any language, or URL name), in tree order. */
export function filterTargets(
  rows: readonly CategoryRow[],
  typed: string,
  locale: string,
): readonly CategoryRow[] {
  const needle = typed.trim().toLocaleLowerCase();
  if (needle === '') return rows;
  return rows.filter(
    (row) =>
      nameOf(row, locale).toLocaleLowerCase().includes(needle) ||
      row.slug.toLocaleLowerCase().includes(needle) ||
      row.names.some((entry) => entry.name.toLocaleLowerCase().includes(needle)),
  );
}
