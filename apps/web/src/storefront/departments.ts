// A product's category as the storefront shows it without a photo: the department (top-level
// category) above it. Cards and the product page carry the department's slug as their `category`,
// so the illustration, the product page's breadcrumb and "show all similar" link find it.

interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
}

/**
 * The department slug of every category id of a tree: each id is walked up to its root. A node
 * whose parent is not in the tree, or a loop in a broken answer, ends the walk at the last node
 * reached, so every id still gets a slug.
 */
export function departmentsOf(rows: readonly TreeNode[]): ReadonlyMap<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string>();
  for (const row of rows) {
    let node = row;
    const seen = new Set<string>([node.id]);
    while (node.parentId !== null) {
      const known = out.get(node.parentId);
      if (known !== undefined) {
        out.set(row.id, known);
        break;
      }
      const parent = byId.get(node.parentId);
      if (parent === undefined || seen.has(parent.id)) break;
      seen.add(parent.id);
      node = parent;
    }
    if (!out.has(row.id)) out.set(row.id, node.slug);
  }
  return out;
}
