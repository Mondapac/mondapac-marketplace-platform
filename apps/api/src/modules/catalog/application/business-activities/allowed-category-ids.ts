import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_TREE_NODES,
  liveCategoryTree,
  type StoredCategoryNode,
} from '../../domain/category-tree';
import type { BusinessActivityRepository } from '../ports/business-activity.repository';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { SellerActivityReader } from '../ports/seller-activity.reader';

/** The platform categories a seller may pick and save: ids only. */
export type AllowedCategoryIds = ReadonlySet<Id<'Category'>>;

/** The activities, their links or the tree could not be read: no category is allowed. */
export interface AllowedCategoryIdsUnavailable {
  readonly code: 'access.unavailable';
}

export interface SellerCategoryScopeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerActivities: SellerActivityReader;
  readonly activities: Pick<BusinessActivityRepository, 'findById'>;
  readonly treeReader: Pick<CategoryTreeReader, 'nodes'>;
}

/**
 * Every live category at or below one of `linkedIds` (pure). The structure is the live tree's
 * (`liveCategoryTree`: a merged ancestor is followed to the one it went into, an archived one is
 * skipped), except that a hidden category counts here as a link in the chain, so a hidden node
 * under a linked category stays inside the scope (whether it may be offered or saved is the other
 * rules' business). A linked id that is not live adds nothing. A tree that cannot be built throws
 * `CategoryTreeUnavailableError`.
 */
export function categoryIdsAtOrBelow(
  nodes: readonly StoredCategoryNode[],
  linkedIds: Iterable<Id<'Category'>>,
): AllowedCategoryIds {
  // Names are not read here; every node gets one so none is dropped for a missing name.
  const structural = nodes.map((node): StoredCategoryNode => ({
    ...node,
    status: node.status === 'hidden' ? 'active' : node.status,
    names: [{ locale: 'und', name: node.id }],
  }));
  const live = liveCategoryTree(structural, 'und');
  const children = new Map<Id<'Category'>, Id<'Category'>[]>();
  const liveIds = new Set<Id<'Category'>>();
  for (const category of live) {
    liveIds.add(category.id);
    if (category.parentId === null) continue;
    const list = children.get(category.parentId) ?? [];
    list.push(category.id);
    children.set(category.parentId, list);
  }
  const allowed = new Set<Id<'Category'>>();
  const queue = [...linkedIds].filter((id) => liveIds.has(id));
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (allowed.has(id)) continue;
    allowed.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return allowed;
}

/**
 * The category scope of a seller (owner decision 2026-10-31): a seller may pick and save only
 * categories inside the business activities assigned to them. One entry point,
 * {@link SellerCategoryScope.allowedCategoryIdsForSeller}, shared by the seller category picker,
 * the seller submit, the category proposal and (later) the seller's platform-product search.
 * An internal service: it declares no access rule; its callers have checked theirs.
 */
export class SellerCategoryScope {
  constructor(private readonly deps: SellerCategoryScopeDependencies) {}

  /**
   * The ids of every category at or below a level 1-2 category linked to one of the seller's
   * ACTIVE business activities (children inherit). A seller with no activity, or with inactive
   * activities only, gets the empty set. Fail closed: the seller's assignment, an activity or the
   * tree that cannot be read is `access.unavailable`, never "every category".
   *
   * Opens its own read-only unit after asking `sellers`, so call it outside any unit (units do not
   * nest), with the seller's own context (or the system actor's, for a job).
   */
  async allowedCategoryIdsForSeller(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<AllowedCategoryIds, AllowedCategoryIdsUnavailable>> {
    const unavailable = err({ code: 'access.unavailable' as const });
    const assigned = await this.deps.sellerActivities.activityIdsOf(context, sellerId);
    if (!assigned.ok) return unavailable;
    if (assigned.value.length === 0) return ok(new Set());
    const { market } = context;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => {
          const linked = new Set<Id<'Category'>>();
          for (const activityId of new Set(assigned.value)) {
            const activity = await this.deps.activities.findById(market, activityId);
            // An unknown activity, another Market's and an inactive one all add nothing.
            if (activity === null || activity.status !== 'active') continue;
            for (const categoryId of activity.categoryIds) linked.add(categoryId);
          }
          if (linked.size === 0) return ok({ linked, nodes: [] });
          const nodes = await this.deps.treeReader.nodes(market, MAX_TREE_NODES + 1);
          return ok({ linked, nodes });
        },
        { readOnly: true },
      );
      if (!read.ok) return unavailable;
      if (read.value.linked.size === 0) return ok(new Set());
      return ok(categoryIdsAtOrBelow(read.value.nodes, read.value.linked));
    } catch {
      // A tree that cannot be built (CategoryTreeUnavailableError) or any read fault.
      return unavailable;
    }
  }
}
