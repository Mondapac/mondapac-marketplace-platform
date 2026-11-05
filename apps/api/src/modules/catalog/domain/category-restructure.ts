import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import {
  descendantsOf,
  isEditable,
  levelOf,
  siblingNameClashes,
  type EditableCategory,
  type FieldIssue,
} from './category-edit';

/**
 * Move, merge and archive of platform categories (categories package C4a; catalog design 4.6;
 * plan sections 3 and 4; review amendments of 4 Nov 2026). Pure planning over the whole tree the
 * unit read: what each category becomes, which ids the certification check must clear, and which
 * subtree's badges are checked again. The use case writes the plan.
 */

/** Products sit on levels 3 and 4 only (plan decision 3): never on a department or a group. */
export const LOWEST_PRODUCT_LEVEL = 3;

/** The reason note of a move, merge or archive (plan section 13), in characters. */
export const RESTRUCTURE_REASON_MIN = 10;
export const RESTRUCTURE_REASON_MAX = 500;

/** Why a move, merge or archive was refused: a stable code and its numbers, never a name. */
export type RestructureRefusal =
  | { readonly code: 'category.not-found' }
  | { readonly code: 'category.parent-not-found' }
  | { readonly code: 'category.target-not-found' }
  | { readonly code: 'category.not-editable' }
  | { readonly code: 'category.move-unchanged' }
  | { readonly code: 'category.cycle' }
  | { readonly code: 'category.depth-exceeded'; readonly max: number }
  | { readonly code: 'category.sibling-name-taken'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'category.products-on-upper-level'; readonly total: number }
  | { readonly code: 'category.has-subcategories' }
  | { readonly code: 'category.only-platform-category'; readonly total: number };

/** What one category becomes; a field left out keeps its value. */
export interface RestructureChange {
  readonly id: Id<'Category'>;
  readonly kind: 'moved' | 'merged' | 'archived';
  readonly parentId?: Id<'Category'> | null;
  readonly position?: number;
  readonly status?: 'active' | 'hidden' | 'merged' | 'archived';
  readonly hiddenById?: Id<'Category'> | null;
  readonly mergedIntoId?: Id<'Category'>;
}

export interface RestructurePlan {
  /** The acted-on category first, then the others in tree order. */
  readonly changes: readonly RestructureChange[];
  /**
   * The ids `certification.assertCategoriesRetirable` must clear (C-4, ADR-0028 d5): the
   * categories that stop being on a path of the affected products. For a move, the moved subtree
   * and the old ancestors that are not ancestors after the move; for a merge, the source and its
   * ancestors that are not the target's; for an archive, the category.
   */
  readonly retirementCheckIds: readonly Id<'Category'>[];
  /** The categories whose products' badges are marked `rechecking` and asked again (M1). */
  readonly affectedIds: readonly Id<'Category'>[];
  /** Level of the acted-on category before and after (an archive keeps its level). */
  readonly levelBefore: number;
  readonly levelAfter: number;
}

/** Direct products per category: published products whose published revision names it. */
export type DirectProducts = ReadonlyMap<string, number>;

const byIdOf = (nodes: readonly EditableCategory[]) =>
  new Map<string, EditableCategory>(nodes.map((node) => [node.id, node]));

/** The ancestors of a category, nearest first (itself not included). */
function ancestorsOf(
  byId: ReadonlyMap<string, EditableCategory>,
  id: Id<'Category'> | null,
): Id<'Category'>[] {
  const found: Id<'Category'>[] = [];
  let next = id === null ? null : (byId.get(id)?.parentId ?? null);
  while (next !== null) {
    found.push(next);
    next = byId.get(next)?.parentId ?? null;
    if (found.length > 64) throw new Error('category tree: loop');
  }
  return found;
}

/** The live (active or hidden) descendants of a category, in tree order. */
const liveDescendants = (nodes: readonly EditableCategory[], id: string) =>
  descendantsOf(nodes, id).filter((node) => isEditable(node.status));

/** The next free position among all children of a parent (any status: the unique key counts them). */
function nextPosition(nodes: readonly EditableCategory[], parentId: Id<'Category'> | null): number {
  let max = -1;
  for (const node of nodes) {
    if (node.parentId === parentId && node.position > max) max = node.position;
  }
  return max + 1;
}

/**
 * The hidden marker of a moved subtree (C3 done: "a move clears or recomputes `hidden_by_id`").
 * `cascadeRoot` is the category whose Hide hides the new parent (the parent itself when hidden on
 * its own), or null under a live parent. A node hidden by a cascade from outside the moved set
 * keeps hidden, now under the new cascade or on its own: a move never shows a category. An active
 * node under a hidden parent is hidden by the parent's cascade, so Show of that root restores it.
 */
function recomputeHidden(
  node: EditableCategory,
  movedIds: ReadonlySet<string>,
  cascadeRoot: Id<'Category'> | null,
): Pick<RestructureChange, 'status' | 'hiddenById'> {
  if (node.status === 'hidden') {
    if (node.hiddenById !== null && !movedIds.has(node.hiddenById)) {
      return { hiddenById: cascadeRoot };
    }
    return {};
  }
  if (node.status === 'active' && cascadeRoot !== null) {
    return { status: 'hidden', hiddenById: cascadeRoot };
  }
  return {};
}

function cascadeRootOf(parent: EditableCategory | undefined): Id<'Category'> | null {
  if (parent === undefined || parent.status !== 'hidden') return null;
  return parent.hiddenById ?? parent.id;
}

/** Products that would sit on level 1 or 2, given each node's level after the change. */
function productsAboveCategoryLevel(
  levels: ReadonlyMap<string, number>,
  direct: DirectProducts,
): number {
  let total = 0;
  for (const [id, level] of levels) {
    if (level < LOWEST_PRODUCT_LEVEL) total += direct.get(id) ?? 0;
  }
  return total;
}

/**
 * Move (plan section 4): a category and its subtree go under a new parent (null: a department),
 * last among its new siblings. Refused for the same parent, a parent inside the subtree (cycle),
 * a subtree deeper than the Market's `maxCategoryDepth`, a name a new sibling already has, or
 * products that would land on level 1 or 2.
 */
export function planMove(
  nodes: readonly EditableCategory[],
  target: EditableCategory,
  newParentId: Id<'Category'> | null,
  maxDepth: number,
  direct: DirectProducts,
): Result<RestructurePlan, RestructureRefusal> {
  if (!isEditable(target.status)) return err({ code: 'category.not-editable' });
  const byId = byIdOf(nodes);
  const parent = newParentId === null ? undefined : byId.get(newParentId);
  if (newParentId !== null && (parent === undefined || !isEditable(parent.status))) {
    return err({ code: 'category.parent-not-found' });
  }
  const subtree = liveDescendants(nodes, target.id);
  if (newParentId === target.id || subtree.some((node) => node.id === newParentId)) {
    return err({ code: 'category.cycle' });
  }
  if (newParentId === target.parentId) return err({ code: 'category.move-unchanged' });

  const levelBefore = levelOf(byId, target.id);
  const levelAfter = (newParentId === null ? 0 : levelOf(byId, newParentId)) + 1;
  const shift = levelAfter - levelBefore;
  const levels = new Map<string, number>([[target.id, levelAfter]]);
  for (const node of subtree) levels.set(node.id, levelOf(byId, node.id) + shift);
  if (Math.max(...levels.values()) > maxDepth) {
    return err({ code: 'category.depth-exceeded', max: maxDepth });
  }
  const clashes = siblingNameClashes(nodes, newParentId, target.id, target.texts);
  if (clashes.length > 0) return err({ code: 'category.sibling-name-taken', fields: clashes });
  const above = productsAboveCategoryLevel(levels, direct);
  if (above > 0) return err({ code: 'category.products-on-upper-level', total: above });

  const movedIds = new Set<string>([target.id, ...subtree.map((node) => node.id)]);
  const cascadeRoot = cascadeRootOf(parent);
  const changes: RestructureChange[] = [
    {
      id: target.id,
      kind: 'moved',
      parentId: newParentId,
      position: nextPosition(nodes, newParentId),
      ...recomputeHidden(target, movedIds, cascadeRoot),
    },
  ];
  for (const node of subtree) {
    const hidden = recomputeHidden(node, movedIds, cascadeRoot);
    if (Object.keys(hidden).length > 0) changes.push({ id: node.id, kind: 'moved', ...hidden });
  }
  const newAncestors = new Set<string>(
    newParentId === null ? [] : [newParentId, ...ancestorsOf(byId, newParentId)],
  );
  const leaving = ancestorsOf(byId, target.id).filter((id) => !newAncestors.has(id));
  return ok({
    changes,
    retirementCheckIds: [...movedIds, ...leaving] as Id<'Category'>[],
    affectedIds: [...movedIds] as Id<'Category'>[],
    levelBefore,
    levelAfter,
  });
}

/**
 * Merge (plan section 4; review amendment C4): the source's children go under the target, last
 * among its children in their own order; the source becomes `merged` into the target (its old id
 * and slug resolve to the target). Refused into itself or its own descendant (cycle), when a moved
 * child would pass `maxCategoryDepth` or clash by name with a child of the target, or when
 * products would land on level 1 or 2.
 */
export function planMerge(
  nodes: readonly EditableCategory[],
  source: EditableCategory,
  targetId: Id<'Category'>,
  maxDepth: number,
  direct: DirectProducts,
): Result<RestructurePlan, RestructureRefusal> {
  if (!isEditable(source.status)) return err({ code: 'category.not-editable' });
  const byId = byIdOf(nodes);
  const target = byId.get(targetId);
  if (target === undefined || !isEditable(target.status)) {
    return err({ code: 'category.target-not-found' });
  }
  const subtree = liveDescendants(nodes, source.id);
  if (targetId === source.id || subtree.some((node) => node.id === targetId)) {
    return err({ code: 'category.cycle' });
  }

  const levelBefore = levelOf(byId, source.id);
  const levelAfter = levelOf(byId, targetId);
  // The source's own products now sit on the target; each child keeps its depth below it.
  const shift = levelAfter - levelBefore;
  const levels = new Map<string, number>([[source.id, levelAfter]]);
  for (const node of subtree) levels.set(node.id, levelOf(byId, node.id) + shift);
  if (Math.max(...levels.values()) > maxDepth) {
    return err({ code: 'category.depth-exceeded', max: maxDepth });
  }
  const children = nodes
    .filter((node) => node.parentId === source.id && isEditable(node.status))
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  const clashes = children.flatMap((child) =>
    siblingNameClashes(nodes, targetId, child.id, child.texts).map((issue) => ({
      path: `children.${child.id}.${issue.path}`,
      code: issue.code,
    })),
  );
  if (clashes.length > 0) return err({ code: 'category.sibling-name-taken', fields: clashes });
  const above = productsAboveCategoryLevel(levels, direct);
  if (above > 0) return err({ code: 'category.products-on-upper-level', total: above });

  const movedIds = new Set<string>(subtree.map((node) => node.id));
  const cascadeRoot = cascadeRootOf(target);
  const first = nextPosition(nodes, targetId);
  const changes: RestructureChange[] = [
    { id: source.id, kind: 'merged', status: 'merged', hiddenById: null, mergedIntoId: targetId },
  ];
  const childIds = new Set(children.map((child) => child.id));
  children.forEach((child, index) => {
    changes.push({
      id: child.id,
      kind: 'moved',
      parentId: targetId,
      position: first + index,
      ...recomputeHidden(child, movedIds, cascadeRoot),
    });
  });
  for (const node of subtree) {
    if (childIds.has(node.id)) continue;
    const hidden = recomputeHidden(node, movedIds, cascadeRoot);
    if (Object.keys(hidden).length > 0) changes.push({ id: node.id, kind: 'moved', ...hidden });
  }
  const kept = new Set<string>([targetId, ...ancestorsOf(byId, targetId)]);
  const leaving = ancestorsOf(byId, source.id).filter((id) => !kept.has(id));
  return ok({
    changes,
    retirementCheckIds: [source.id, ...leaving],
    affectedIds: [source.id, ...movedIds] as Id<'Category'>[],
    levelBefore,
    levelAfter,
  });
}

/**
 * Archive (plan decision 7): terminal, no restore. Only a category with no live subcategory (move
 * or archive those first), and never while a published product would be left with no live
 * platform category (catalog design AC 4): `onlyHere` is that count, read in the unit.
 */
export function planArchive(
  nodes: readonly EditableCategory[],
  target: EditableCategory,
  onlyHere: number,
): Result<RestructurePlan, RestructureRefusal> {
  if (!isEditable(target.status)) return err({ code: 'category.not-editable' });
  if (nodes.some((node) => node.parentId === target.id && isEditable(node.status))) {
    return err({ code: 'category.has-subcategories' });
  }
  if (onlyHere > 0) return err({ code: 'category.only-platform-category', total: onlyHere });
  const level = levelOf(byIdOf(nodes), target.id);
  return ok({
    changes: [{ id: target.id, kind: 'archived', status: 'archived', hiddenById: null }],
    retirementCheckIds: [target.id],
    affectedIds: [target.id],
    levelBefore: level,
    levelAfter: level,
  });
}

/** A node as the feature-set count reads it: its id and parent only. */
export interface TreeEdge {
  readonly id: string;
  readonly parentId: string | null;
}

/**
 * How many products a move or merge would give another feature set (review amendments, C4: the
 * impact adds "feature set changes for N products" once A4 is merged). A category's feature set is
 * the one of the nearest category, itself first, that holds one (`resolveEffective`). A move puts
 * `id` under `targetId` (null: a department); a merge puts the source's products on `targetId` and
 * its children under it. A product counts once when one of its categories in the moved subtree,
 * or the merged source, ends with another feature set. Advisory, like the rest of the impact.
 */
export function featureSetChanges(
  nodes: readonly TreeEdge[],
  id: string,
  action: 'move' | 'merge',
  targetId: string | null,
  familyOf: (categoryId: string) => string | null | undefined,
  facts: readonly { readonly categoryIds: readonly string[] }[],
): number {
  const parentBefore = new Map<string, string | null>(
    nodes.map((node) => [node.id, node.parentId]),
  );
  const parentAfter = new Map(parentBefore);
  if (action === 'move') {
    parentAfter.set(id, targetId);
  } else {
    for (const node of nodes) if (node.parentId === id) parentAfter.set(node.id, targetId);
  }
  const effective = (parents: ReadonlyMap<string, string | null>, start: string): string | null => {
    let next: string | null = start;
    for (let steps = 0; next !== null && steps <= 64; steps += 1) {
      const family = familyOf(next);
      if (family !== undefined && family !== null) return family;
      next = parents.get(next) ?? null;
    }
    return null;
  };
  const inSubtree = (start: string): boolean => {
    let next: string | null = start;
    for (let steps = 0; next !== null && steps <= 64; steps += 1) {
      if (next === id) return true;
      next = parentBefore.get(next) ?? null;
    }
    return false;
  };
  const changes = new Map<string, boolean>();
  const changed = (categoryId: string): boolean => {
    const known = changes.get(categoryId);
    if (known !== undefined) return known;
    const before = effective(parentBefore, categoryId);
    const after =
      action === 'merge' && categoryId === id
        ? effective(parentAfter, targetId ?? categoryId)
        : effective(parentAfter, categoryId);
    const answer = before !== after;
    changes.set(categoryId, answer);
    return answer;
  };
  let total = 0;
  for (const fact of facts) {
    const affected = fact.categoryIds.filter(
      (categoryId) => parentBefore.has(categoryId) && inSubtree(categoryId),
    );
    if (affected.some(changed)) total += 1;
  }
  return total;
}
