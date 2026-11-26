// A product's place in the live category tree, from the category ids the API sends (catalog ids
// are UUIDs, never a slug or a name). The product page shows the path as its breadcrumb (Meat >
// Lamb > Lamb roasts); the illustration stays the department's (./departments.ts).

/** A tree node as this file needs it. */
export interface CategoryNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly name: string;
}

/** One step of a product's category path, top level first. */
export interface CategoryStep {
  readonly code: string;
  readonly name: string;
}

/** The path from the top level to the node with this id; empty when the tree has no such node. */
export function pathOf(rows: readonly CategoryNode[], id: string): CategoryNode[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const path: CategoryNode[] = [];
  const seen = new Set<string>();
  let node = byId.get(id);
  // A missing parent or a loop ends the walk: the path then starts at the last known node.
  while (node !== undefined && !seen.has(node.id)) {
    seen.add(node.id);
    path.unshift(node);
    node = node.parentId === null ? undefined : byId.get(node.parentId);
  }
  return path;
}

/**
 * A product's breadcrumb path from its category ids: the path of the first id the tree knows.
 * Undefined when the tree knows none of them (the page then shows no category, never an id).
 */
export function categoryTrailOf(
  rows: readonly CategoryNode[],
  categoryIds: readonly unknown[],
): readonly CategoryStep[] | undefined {
  for (const id of categoryIds) {
    if (typeof id !== 'string') continue;
    const path = pathOf(rows, id);
    if (path.length > 0) return path.map((n) => ({ code: n.slug, name: n.name }));
  }
  return undefined;
}
