import type { Id } from '@mondapac/shared-kernel';

/** A live platform category with its public name, as the "In categories" counts need it. */
export interface NamedCategory {
  readonly id: Id<'Category'>;
  readonly parentId: Id<'Category'> | null;
  readonly name: string;
}

/** One document of a query's scope: only what counting needs. One row per indexed Offer. */
export interface ScopeRow {
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  readonly categoryIds: readonly Id<'Category'>[];
}

/** One line of "In categories": a category right below the asked one, with its product count. */
export interface CategoryCount {
  readonly categoryId: Id<'Category'>;
  readonly name: string;
  readonly count: number;
}

/** The most lines "In categories" returns. */
export const MAX_CATEGORY_COUNTS = 12;

/** The most scope rows one count reads; one more is read so a cut is known. */
export const MAX_SCOPE_ROWS = 20_000;

export interface ScopeCounts {
  /** Products (never Offers) in the scope; a lower bound when `totalIsCapped`. */
  readonly total: number;
  /** True when the scope held more than {@link MAX_SCOPE_ROWS} documents: `total` is then a floor. */
  readonly totalIsCapped: boolean;
  /** Categories right below the asked one (the top level when none is asked), most products first. */
  readonly categoryCounts: readonly CategoryCount[];
  /** Distinct stores that have a product in the scope. */
  readonly storeCount: number;
}

/**
 * Counts of a query's scope (pure). Products are counted once however many sellers offer them (one
 * card per product, decision 4). A product counts in a category when one of its categories is that
 * category or sits under it, so a deep product rolls up into the line of the category right below
 * the asked one. `asked` is the category the list is in, or null for the whole Market; a category the
 * live tree does not hold has no lines. Names are the tree's (public). Counts come from the index
 * and do not run the query-time visibility check, so they may briefly include an Offer that just
 * became unsellable. Rows over the cap are ignored, and `totalIsCapped` says so.
 */
export function countScope(
  rows: readonly ScopeRow[],
  tree: readonly NamedCategory[],
  asked: Id<'Category'> | null,
): ScopeCounts {
  const capped = rows.length > MAX_SCOPE_ROWS;
  const used = capped ? rows.slice(0, MAX_SCOPE_ROWS) : rows;
  const byId = new Map(tree.map((node) => [node.id, node]));
  // The line a category rolls up into: the ancestor (or itself) whose parent is `asked`.
  const lineOf = (categoryId: Id<'Category'>): Id<'Category'> | null => {
    let current = byId.get(categoryId);
    const seen = new Set<Id<'Category'>>();
    while (current !== undefined && !seen.has(current.id)) {
      if (current.parentId === asked) return current.id;
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return null;
  };
  const products = new Set<Id<'Product'>>();
  const stores = new Set<Id<'Seller'>>();
  const lines = new Map<Id<'Category'>, Set<Id<'Product'>>>();
  for (const row of used) {
    products.add(row.productId);
    stores.add(row.sellerId);
    for (const categoryId of row.categoryIds) {
      const line = lineOf(categoryId);
      if (line === null) continue;
      const set = lines.get(line);
      if (set === undefined) lines.set(line, new Set([row.productId]));
      else set.add(row.productId);
    }
  }
  const categoryCounts = [...lines]
    .map(([categoryId, set]) => ({
      categoryId,
      name: byId.get(categoryId)?.name ?? '',
      count: set.size,
    }))
    .filter((line) => line.name !== '')
    .sort(
      (a, b) =>
        b.count - a.count || a.name.localeCompare(b.name) || (a.categoryId < b.categoryId ? -1 : 1),
    )
    .slice(0, MAX_CATEGORY_COUNTS);
  return { total: products.size, totalIsCapped: capped, categoryCounts, storeCount: stores.size };
}
