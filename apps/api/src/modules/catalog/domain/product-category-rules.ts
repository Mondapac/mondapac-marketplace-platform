/**
 * The category rules of a product at submit (categories package C5a, decision 4): one to three
 * platform categories, each `active` or `hidden` and on level 3 or 4 of the tree, and exactly one
 * of them primary. The primary is the first id listed (the revision store marks the first one
 * `is_primary`), so "exactly one" holds by construction; a repeated id is refused.
 */
export const MAX_PRODUCT_CATEGORIES = 3;
/** Products sit on level 3 (category) or 4 (subcategory) only. */
export const LOWEST_PRODUCT_CATEGORY_LEVEL = 3;

export interface ProductCategoryNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: string;
}

export interface ProductCategoryIssue {
  readonly path: string;
  readonly code:
    | 'required'
    | 'too-many'
    | 'duplicate'
    | 'unknown'
    | 'category.not-available'
    | 'category.level-not-allowed';
}

/** Level of a node, 1 for a department; 0 when the chain is broken or loops. */
export function levelOf(byId: ReadonlyMap<string, ProductCategoryNode>, id: string): number {
  let level = 0;
  let cursor: string | null = id;
  const seen = new Set<string>();
  while (cursor !== null) {
    const node = byId.get(cursor);
    if (node === undefined || seen.has(cursor)) return 0;
    seen.add(cursor);
    level += 1;
    cursor = node.parentId;
  }
  return level;
}

/**
 * Checks the listed category ids against the tree. Codes and paths only. `maxLevel` is the
 * Market's `catalog.maxCategoryDepth` (AU 4, ZZ 3): products sit on levels 3 up to that depth.
 */
export function checkProductCategories(
  nodes: readonly ProductCategoryNode[],
  categoryIds: readonly string[],
  maxLevel: number,
): readonly ProductCategoryIssue[] {
  if (categoryIds.length === 0) return [{ path: 'categoryIds', code: 'required' }];
  const issues: ProductCategoryIssue[] = [];
  if (categoryIds.length > MAX_PRODUCT_CATEGORIES) {
    issues.push({ path: 'categoryIds', code: 'too-many' });
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  categoryIds.forEach((id, index) => {
    const path = `categoryIds.${index}`;
    if (seen.has(id)) {
      issues.push({ path, code: 'duplicate' });
      return;
    }
    seen.add(id);
    const node = byId.get(id);
    if (node === undefined) {
      issues.push({ path, code: 'unknown' });
      return;
    }
    if (node.status !== 'active' && node.status !== 'hidden') {
      issues.push({ path, code: 'category.not-available' });
      return;
    }
    const level = levelOf(byId, id);
    if (level < LOWEST_PRODUCT_CATEGORY_LEVEL || level > maxLevel) {
      issues.push({ path, code: 'category.level-not-allowed' });
    }
  });
  return issues;
}
