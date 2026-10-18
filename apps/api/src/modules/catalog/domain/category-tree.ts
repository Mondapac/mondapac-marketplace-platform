import type { Id } from '@mondapac/shared-kernel';
import type { CategoryName, CategoryStatus } from './platform-category';

/** Deeper than any tree the no-cycle trigger allows (data design 3.4: refused at 64). */
export const MAX_TREE_DEPTH = 64;
/** The most categories one Market's tree may hold before the public read refuses (fail closed). */
export const MAX_TREE_NODES = 5000;

/** One stored category as the tree read sees it: the root row plus its published names. */
export interface StoredCategoryNode {
  readonly id: Id<'Category'>;
  readonly parentId: Id<'Category'> | null;
  readonly status: CategoryStatus;
  readonly mergedIntoId: Id<'Category'> | null;
  readonly slug: string;
  /** The published revision's names; empty when the category is not active. */
  readonly names: readonly CategoryName[];
}

/** One live category of the public tree. */
export interface LiveCategory {
  readonly id: Id<'Category'>;
  /** The nearest live ancestor; null for a top-level category. */
  readonly parentId: Id<'Category'> | null;
  readonly slug: string;
  readonly name: string;
  /** 0 for a top-level category. */
  readonly depth: number;
  /** The place among its siblings, from 0, by name in the locale, then by id. */
  readonly position: number;
}

/** The stored tree cannot be turned into a live tree; nothing is answered from it. */
export class CategoryTreeUnavailableError extends Error {
  constructor(reason: string) {
    super(`category tree unavailable: ${reason}`);
    this.name = 'CategoryTreeUnavailableError';
  }
}

/**
 * The live tree of a Market (pure). Only `active` categories appear. A category's parent is its
 * nearest live ancestor, with the rules of `platformCategoryPaths` (catalog design 4.6): a merged
 * ancestor is followed to the one it was merged into, an archived ancestor is skipped and its own
 * parent kept. The name is the one in `locale` (the Market's default locale), else the first
 * locale in code order (INTL-13); a live category with no name at all is left out with its
 * subtree.
 * The answer is depth first, siblings by name (`Intl.Collator` of `locale`) then id, so the
 * order is stable. A missing ancestor, a loop or a tree deeper than {@link MAX_TREE_DEPTH} throws
 * {@link CategoryTreeUnavailableError}: the caller answers unavailable, never a partial tree.
 */
export function liveCategoryTree(
  nodes: readonly StoredCategoryNode[],
  locale: string,
): readonly LiveCategory[] {
  if (nodes.length > MAX_TREE_NODES) throw new CategoryTreeUnavailableError('too many');
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const liveParent = (node: StoredCategoryNode): Id<'Category'> | null => {
    let next = node.parentId;
    for (let steps = 0; next !== null; steps += 1) {
      if (steps > MAX_TREE_DEPTH * 2) throw new CategoryTreeUnavailableError('loop');
      const ancestor = byId.get(next);
      if (ancestor === undefined) throw new CategoryTreeUnavailableError('missing ancestor');
      if (ancestor.status === 'active') return ancestor.id;
      if (ancestor.status === 'merged') {
        if (ancestor.mergedIntoId === null) throw new CategoryTreeUnavailableError('merge');
        next = ancestor.mergedIntoId;
      } else {
        next = ancestor.parentId;
      }
    }
    return null;
  };
  const nameOf = (node: StoredCategoryNode): string | null => {
    const wanted = node.names.find((entry) => entry.locale === locale);
    const first = [...node.names].sort((a, b) => (a.locale < b.locale ? -1 : 1))[0];
    return (wanted ?? first)?.name ?? null;
  };

  const children = new Map<Id<'Category'> | null, { node: StoredCategoryNode; name: string }[]>();
  for (const node of nodes) {
    if (node.status !== 'active') continue;
    const name = nameOf(node);
    if (name === null) continue;
    const parent = liveParent(node);
    const list = children.get(parent) ?? [];
    list.push({ node, name });
    children.set(parent, list);
  }
  const collator = new Intl.Collator(locale);
  const tree: LiveCategory[] = [];
  const visit = (parentId: Id<'Category'> | null, depth: number): void => {
    const list = children.get(parentId);
    if (list === undefined) return;
    if (depth >= MAX_TREE_DEPTH) throw new CategoryTreeUnavailableError('too deep');
    list.sort(
      (a, b) =>
        collator.compare(a.name, b.name) ||
        (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
    );
    list.forEach(({ node, name }, position) => {
      tree.push({ id: node.id, parentId, slug: node.slug, name, depth, position });
      visit(node.id, depth + 1);
    });
  };
  visit(null, 0);
  return tree;
}
