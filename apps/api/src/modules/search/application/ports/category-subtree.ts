import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * What a category filter covers: the asked platform category and every live category under it
 * (see `categorySubtree`), read from catalog's public category tree with the caller's context.
 * `null` when the tree cannot be read or the subtree is too large: the caller fails closed
 * (`search.unavailable`), never a filter that silently drops subcategories.
 */
export interface CategorySubtreeSource {
  subtreeOf(
    context: CallContext,
    categoryId: Id<'Category'>,
  ): Promise<readonly Id<'Category'>[] | null>;
}

export const CATEGORY_SUBTREE_SOURCE = Symbol('CATEGORY_SUBTREE_SOURCE');
