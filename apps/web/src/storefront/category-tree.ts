import 'server-only';
import { cache } from 'react';
import { apiGet, type ApiRead } from './api.ts';
import { CATEGORY_SLUG } from './links.ts';
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
  /**
   * Shown in menus and the sitemap (categories C6a: its Show in menu switch is on, it has live
   * products and its parent is in the menu). An answer without the field counts as shown.
   */
  readonly inMenu: boolean;
  /** A listed product is on it or below it; undefined when the answer does not say. */
  readonly hasLiveProducts?: boolean;
  readonly shortDescription?: string;
  /** English only; absent fields are not set by the admin. */
  readonly seo?: {
    readonly title?: string;
    readonly description?: string;
    readonly noindex: boolean;
  };
}

export { CATEGORY_SLUG };

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
    if (slug === undefined || name === undefined || !CATEGORY_SLUG.test(slug)) continue;
    if (row.parentId !== null && (typeof row.parentId !== 'string' || !UUID.test(row.parentId)))
      continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push({ id: row.id, parentId: row.parentId, slug, name, ...detailsOf(row) });
  }
  return rows;
}

/** The C6a fields of a row: each one is kept only when it has the right type. */
function detailsOf(
  row: Record<string, unknown>,
): Omit<TreeRow, 'id' | 'parentId' | 'slug' | 'name'> {
  const shortDescription = textOf(row.shortDescription, 300);
  const seo = isObject(row.seo) ? row.seo : undefined;
  const title = seo === undefined ? undefined : textOf(seo.title, 60);
  const description = seo === undefined ? undefined : textOf(seo.description, 160);
  return {
    inMenu: row.inMenu !== false,
    ...(typeof row.hasLiveProducts === 'boolean' ? { hasLiveProducts: row.hasLiveProducts } : {}),
    ...(shortDescription === undefined ? {} : { shortDescription }),
    ...(seo === undefined
      ? {}
      : {
          seo: {
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { description }),
            noindex: seo.noindex === true,
          },
        }),
  };
}

/** The rows a menu may show (decision 11: an empty or switched-off category is not offered). */
export const menuRows = (rows: readonly TreeRow[]): TreeRow[] => rows.filter((r) => r.inMenu);

/** The ancestors of a node, top level first; stops at a missing parent or a loop. */
export function trailOf(rows: readonly TreeRow[], node: TreeRow): TreeRow[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const trail: TreeRow[] = [];
  const seen = new Set([node.id]);
  let parent = node.parentId === null ? undefined : byId.get(node.parentId);
  while (parent !== undefined && !seen.has(parent.id)) {
    seen.add(parent.id);
    trail.unshift(parent);
    parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
  }
  return trail;
}

/** How deep a node is: 0 at the top level. */
export const depthOf = (rows: readonly TreeRow[], node: TreeRow): number =>
  trailOf(rows, node).length;

/** The slug of each category id, for the card's illustration. */
export const slugsOf = (rows: readonly TreeRow[]): ReadonlyMap<string, string> =>
  new Map(rows.map((r) => [r.id, r.slug]));

/**
 * A node as the site's category: its direct children in the menu are the subcategories (a child
 * that is empty or switched out of the menu is not offered as a link).
 */
export function categoryOf(rows: readonly TreeRow[], node: TreeRow, label?: string): Category {
  const name = label ?? node.name;
  return {
    code: node.slug,
    name,
    shortName: name,
    children: rows
      .filter((r) => r.parentId === node.id && r.inMenu)
      .map((r) => ({ code: r.slug, name: r.name })),
  };
}

/** The top level of the menu, in the API's order (depth first, so by the admin's position). */
export const topCategories = (rows: readonly TreeRow[]): Category[] =>
  rows.filter((r) => r.parentId === null && r.inMenu).map((r) => categoryOf(rows, r));

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
