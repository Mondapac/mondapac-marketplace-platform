import type { Id } from '@mondapac/shared-kernel';

/**
 * The most categories one category filter may name: the asked category and every live category
 * under it. The raw statements bind at most this many ids; a larger subtree is refused (the caller
 * answers unavailable), never cut to a partial filter.
 */
export const MAX_FILTER_CATEGORIES = 1000;

/** A node of the live platform category tree, as search needs it. */
export interface CategoryNode {
  readonly id: Id<'Category'>;
  readonly parentId: Id<'Category'> | null;
}

/**
 * The asked category first, then every category under it in the live tree, breadth first (pure).
 * A category the live tree does not hold (unknown, archived, merged away) is itself alone, so a
 * filter on it finds the documents that name it directly, as before. Null when the subtree is
 * larger than {@link MAX_FILTER_CATEGORIES}.
 */
export function categorySubtree(
  nodes: readonly CategoryNode[],
  categoryId: Id<'Category'>,
): readonly Id<'Category'>[] | null {
  const children = new Map<Id<'Category'>, Id<'Category'>[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId);
    if (siblings === undefined) children.set(node.parentId, [node.id]);
    else siblings.push(node.id);
  }
  const subtree: Id<'Category'>[] = [categoryId];
  const seen = new Set(subtree);
  for (let index = 0; index < subtree.length; index += 1) {
    for (const child of children.get(subtree[index]!) ?? []) {
      // The live tree has no loops; the set keeps a bad answer from looping here.
      if (seen.has(child)) continue;
      seen.add(child);
      subtree.push(child);
      if (subtree.length > MAX_FILTER_CATEGORIES) return null;
    }
  }
  return subtree;
}
