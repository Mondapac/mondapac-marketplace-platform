import 'server-only';
import { cache } from 'react';
import { apiGet, type ApiRead } from './api.ts';
import { isObject, textOf } from './home-source.ts';
import type { Category } from './types.ts';

// The live category tree (`GET catalog/categories`) as the category page, the search page and the
// shell use it. `categoriesOf` in ./home-source.ts keeps the home page's view (top level with
// child names); the listing also needs every node's id (the search route takes the platform
// category id) and any node by its slug, so the rows are kept whole here. The body is untrusted:
// a row without a UUID id, a slug of lower-case letters, digits and hyphens or a name is dropped.

export interface TreeRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly name: string;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Most rows read from one tree answer; a Market's tree is far smaller, the rest is ignored. */
export const MAX_TREE_ROWS = 5000;

/** One read of a public route per request, however many parts of the page ask (layout, page). */
export const readOnce: (path: string) => Promise<ApiRead<unknown>> = cache((path: string) =>
  apiGet<unknown>(path),
);

/** The valid rows of a tree answer, or null when the answer is not a tree at all. */
export function treeOf(body: unknown): TreeRow[] | null {
  if (!isObject(body) || !Array.isArray(body.categories)) return null;
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  for (const row of body.categories as unknown[]) {
    if (rows.length >= MAX_TREE_ROWS) break;
    if (!isObject(row) || typeof row.id !== 'string' || !UUID.test(row.id)) continue;
    const slug = textOf(row.slug, 120);
    const name = textOf(row.name, 120);
    if (slug === undefined || name === undefined || !/^[a-z0-9-]+$/u.test(slug)) continue;
    if (row.parentId !== null && (typeof row.parentId !== 'string' || !UUID.test(row.parentId)))
      continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push({ id: row.id, parentId: row.parentId, slug, name });
  }
  return rows;
}

/** The slug of each category id, for the card's illustration. */
export const slugsOf = (rows: readonly TreeRow[]): ReadonlyMap<string, string> =>
  new Map(rows.map((r) => [r.id, r.slug]));

/** A node as the site's category: its direct children are the subcategories. */
export function categoryOf(rows: readonly TreeRow[], node: TreeRow, label?: string): Category {
  const name = label ?? node.name;
  return {
    code: node.slug,
    name,
    shortName: name,
    children: rows
      .filter((r) => r.parentId === node.id)
      .map((r) => ({ code: r.slug, name: r.name })),
  };
}

/** The top level of the tree, in the API's order (depth first, so by position). */
export const topCategories = (rows: readonly TreeRow[]): Category[] =>
  rows.filter((r) => r.parentId === null).map((r) => categoryOf(rows, r));

/**
 * The category `/c/<slug>` names, and with `sub` its child of that slug. A slug names the top
 * level first; a node deeper in the tree answers its own slug only when no top-level one does
 * (the navigation may list any category).
 */
export function findInTree(
  rows: readonly TreeRow[],
  slug: string,
  sub?: string,
): { readonly node: TreeRow; readonly child?: TreeRow } | undefined {
  const node =
    rows.find((r) => r.slug === slug && r.parentId === null) ?? rows.find((r) => r.slug === slug);
  if (node === undefined) return undefined;
  if (sub === undefined) return { node };
  const child = rows.find((r) => r.parentId === node.id && r.slug === sub);
  return child === undefined ? undefined : { node, child };
}
