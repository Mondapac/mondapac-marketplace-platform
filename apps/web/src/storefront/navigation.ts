import 'server-only';
import { isObject, textOf } from './home-source.ts';
import { categoryOf, type TreeRow } from './category-tree.ts';
import type { Category } from './types.ts';

// The approved navigation (`GET storefront/navigation`, storefront module): the page of template
// system.navigation, slots `rail` (nav-link), `drawer-popular` and `drawer-categories`
// (nav-category: `{ categoryId, label? }`). It is empty until a platform admin approves one.
// Only the two drawer slots are read here: the rail's entries are fixed in the app today.
// A category is named by id, so each id must be in the live tree; one that is not (removed since
// the approval) is dropped.

export interface Navigation {
  /** The Browse drawer's category list, in the admin's order. */
  readonly categories: readonly Category[];
  /** The names of the drawer's popular entries, which the search panel offers as search words. */
  readonly popular: readonly string[];
}

/** The category entries of one slot of a published page, in order. */
function entriesOf(page: Record<string, unknown>, key: string) {
  const entries: { readonly id: string; readonly label?: string }[] = [];
  if (!Array.isArray(page.slots)) return entries;
  for (const slot of page.slots as unknown[]) {
    if (!isObject(slot) || slot.key !== key || !Array.isArray(slot.modules)) continue;
    for (const entry of slot.modules as unknown[]) {
      if (!isObject(entry) || entry.module !== 'nav-category' || !isObject(entry.config)) continue;
      const { categoryId } = entry.config;
      if (typeof categoryId !== 'string') continue;
      const label = textOf(entry.config.label, 40);
      entries.push({ id: categoryId, ...(label === undefined ? {} : { label }) });
    }
  }
  return entries;
}

/** The drawer lists of a navigation answer, or null when the answer is not a page. */
export function navigationOf(body: unknown, rows: readonly TreeRow[]): Navigation | null {
  if (!isObject(body) || body.kind !== 'page' || !isObject(body.page)) return null;
  const known = (entries: ReturnType<typeof entriesOf>) => {
    const seen = new Set<string>();
    return entries.flatMap((entry) => {
      const node = rows.find((r) => r.id === entry.id);
      if (node === undefined || seen.has(node.id)) return [];
      seen.add(node.id);
      return [{ node, label: entry.label }];
    });
  };
  return {
    categories: known(entriesOf(body.page, 'drawer-categories')).map(({ node, label }) =>
      categoryOf(rows, node, label),
    ),
    popular: [
      ...new Set(known(entriesOf(body.page, 'drawer-popular')).map((e) => e.label ?? e.node.name)),
    ],
  };
}
