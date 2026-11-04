import type { Id } from '@mondapac/shared-kernel';
import { CategoryTreeUnavailableError, MAX_TREE_DEPTH, MAX_TREE_NODES } from './category-tree';
import type { CategoryName, CategoryStatus } from './platform-category';

/** One stored category as the admin read sees it: any status, with the names of its revision. */
export interface AdminStoredCategory {
  readonly id: Id<'Category'>;
  readonly parentId: Id<'Category'> | null;
  readonly slug: string;
  readonly status: CategoryStatus;
  readonly mergedIntoId: Id<'Category'> | null;
  /** The names of the published revision, one per locale. */
  readonly names: readonly CategoryName[];
  /** The number of the published revision. */
  readonly revisionNo: number;
  /** Optimistic version of the category root. */
  readonly version: number;
}

/**
 * What the counts need to know about one published product: the categories its published
 * revision names and the numbers of its Offers (catalog design 9.2a, `platform-category.impact`).
 */
export interface CategoryProductFact {
  readonly categoryIds: readonly string[];
  /** Offers that are not deleted. */
  readonly offers: number;
  /** Offers that are on sale (`listed`). */
  readonly listedOffers: number;
  /** Offers with at least one `active` certification tag. */
  readonly offersWithActiveTag: number;
}

/** The counts of one category. A product with a listed Offer is live. */
export interface CategoryCounts {
  /** Live products in the category and everything under it (a product counts once). */
  readonly liveProducts: number;
  /** Live products that name this category itself. */
  readonly liveProductsDirect: number;
  /** Non-deleted Offers on the products of the subtree. */
  readonly offers: number;
}

export interface AdminCategoryRow {
  readonly id: Id<'Category'>;
  readonly parentId: Id<'Category'> | null;
  readonly slug: string;
  readonly status: CategoryStatus;
  readonly mergedIntoId: Id<'Category'> | null;
  readonly names: readonly CategoryName[];
  /** 0 for a department. */
  readonly depth: number;
  /** Place among its siblings from 0: by name until the position column exists (C2). */
  readonly position: number;
  readonly version: number;
  readonly counts: CategoryCounts;
}

/** The impact of a structural change on the subtree of one category (catalog design 9.2a). */
export interface CategoryImpactCounts {
  /** Published products whose published revision names the category or a descendant. */
  readonly products: number;
  /** Published products that name the category itself. */
  readonly directProducts: number;
  /** Non-deleted Offers on those products. */
  readonly offers: number;
  /** Listed Offers on those products. */
  readonly listedOffers: number;
  /** Offers on those products with an active certification tag. */
  readonly offersWithActiveTag: number;
  /** Categories under this one, any status. */
  readonly descendants: number;
}

interface Index {
  readonly byId: ReadonlyMap<string, AdminStoredCategory>;
  /** The chain from a category up to its root, itself first. */
  readonly chainOf: (id: string) => readonly string[];
  readonly children: ReadonlyMap<string | null, readonly AdminStoredCategory[]>;
}

function indexOf(nodes: readonly AdminStoredCategory[]): Index {
  if (nodes.length > MAX_TREE_NODES) throw new CategoryTreeUnavailableError('too many');
  const byId = new Map(nodes.map((node) => [node.id as string, node] as const));
  const chains = new Map<string, readonly string[]>();
  const chainOf = (id: string): readonly string[] => {
    const known = chains.get(id);
    if (known !== undefined) return known;
    const chain: string[] = [];
    let next: string | null = id;
    while (next !== null) {
      if (chain.length > MAX_TREE_DEPTH) throw new CategoryTreeUnavailableError('loop');
      const node = byId.get(next);
      if (node === undefined) throw new CategoryTreeUnavailableError('missing ancestor');
      chain.push(next);
      next = node.parentId;
    }
    chains.set(id, chain);
    return chain;
  };
  const children = new Map<string | null, AdminStoredCategory[]>();
  for (const node of nodes) {
    chainOf(node.id);
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  return { byId, chainOf, children };
}

/** The name in `locale`, else the first locale in code order; null for no name at all. */
export function categoryNameIn(names: readonly CategoryName[], locale: string): string | null {
  const wanted = names.find((entry) => entry.locale === locale);
  const first = [...names].sort((a, b) => (a.locale < b.locale ? -1 : 1))[0];
  return (wanted ?? first)?.name ?? null;
}

function siblingsOrdered(
  list: readonly AdminStoredCategory[],
  locale: string,
): readonly AdminStoredCategory[] {
  const collator = new Intl.Collator(locale);
  return [...list].sort((a, b) => {
    const byName = collator.compare(
      categoryNameIn(a.names, locale) ?? '',
      categoryNameIn(b.names, locale) ?? '',
    );
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The whole tree of a Market for the admin page (pure): every category in any status, depth first,
 * siblings by name in `locale` then id, each with its depth, its place among its siblings and its
 * counts. A missing parent, a loop or a tree that is too large throws
 * {@link CategoryTreeUnavailableError}: the caller answers unavailable, never a partial tree.
 *
 * A product counts once in every category of the subtree it sits in, however many of its (up to
 * three) categories lie there. Only published products are given in `facts`; a product is live
 * when it has a listed Offer. A fact naming a category the tree does not hold is ignored.
 */
export function adminCategoryTree(
  nodes: readonly AdminStoredCategory[],
  locale: string,
  facts: readonly CategoryProductFact[],
): readonly AdminCategoryRow[] {
  const { chainOf, children } = indexOf(nodes);
  const live = new Map<string, number>();
  const liveDirect = new Map<string, number>();
  const offers = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string, by: number): void => {
    map.set(key, (map.get(key) ?? 0) + by);
  };
  for (const fact of facts) {
    const isLive = fact.listedOffers > 0;
    const known = fact.categoryIds.filter((id) => chains(chainOf, id));
    const subtree = new Set<string>();
    for (const id of known) for (const ancestor of chainOf(id)) subtree.add(ancestor);
    for (const id of subtree) {
      if (isLive) bump(live, id, 1);
      bump(offers, id, fact.offers);
    }
    if (isLive) for (const id of new Set(known)) bump(liveDirect, id, 1);
  }

  const rows: AdminCategoryRow[] = [];
  const walk = (parent: string | null, depth: number): void => {
    const ordered = siblingsOrdered(children.get(parent) ?? [], locale);
    ordered.forEach((node, position) => {
      rows.push({
        id: node.id,
        parentId: node.parentId,
        slug: node.slug,
        status: node.status,
        mergedIntoId: node.mergedIntoId,
        names: [...node.names].sort((a, b) => (a.locale < b.locale ? -1 : 1)),
        depth,
        position,
        version: node.version,
        counts: {
          liveProducts: live.get(node.id) ?? 0,
          liveProductsDirect: liveDirect.get(node.id) ?? 0,
          offers: offers.get(node.id) ?? 0,
        },
      });
      walk(node.id, depth + 1);
    });
  };
  walk(null, 0);
  return rows;
}

const chains = (chainOf: Index['chainOf'], id: string): boolean => {
  try {
    chainOf(id);
    return true;
  } catch {
    return false;
  }
};

/** The categories above `id`, the root first and `id` last. Empty for an unknown id. */
export function categoryPath(
  nodes: readonly AdminStoredCategory[],
  id: string,
): readonly AdminStoredCategory[] {
  const { byId, chainOf } = indexOf(nodes);
  if (!byId.has(id)) return [];
  return [...chainOf(id)].reverse().map((entry) => byId.get(entry)!);
}

/**
 * The impact of a change to the subtree of `id` (pure): see {@link CategoryImpactCounts}. An
 * unknown `id` counts nothing.
 */
export function categoryImpact(
  nodes: readonly AdminStoredCategory[],
  id: string,
  facts: readonly CategoryProductFact[],
): CategoryImpactCounts {
  const { byId, chainOf } = indexOf(nodes);
  const empty: CategoryImpactCounts = {
    products: 0,
    directProducts: 0,
    offers: 0,
    listedOffers: 0,
    offersWithActiveTag: 0,
    descendants: 0,
  };
  if (!byId.has(id)) return empty;
  let products = 0;
  let directProducts = 0;
  let offers = 0;
  let listedOffers = 0;
  let offersWithActiveTag = 0;
  for (const fact of facts) {
    const known = fact.categoryIds.filter((entry) => chains(chainOf, entry));
    if (!known.some((entry) => chainOf(entry).includes(id))) continue;
    products += 1;
    if (known.includes(id)) directProducts += 1;
    offers += fact.offers;
    listedOffers += fact.listedOffers;
    offersWithActiveTag += fact.offersWithActiveTag;
  }
  let descendants = 0;
  for (const node of nodes) if (node.id !== id && chainOf(node.id).includes(id)) descendants += 1;
  return { products, directProducts, offers, listedOffers, offersWithActiveTag, descendants };
}
