import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogAssistantFacade } from '../../catalog';
import type { CategorySubtreeSource } from '../application/ports/category-subtree';
import { categorySubtree } from '../domain/category-subtree';

/**
 * {@link CategorySubtreeSource} over catalog's public category tree (`catalog.category-tree`, rule
 * `anonymous`, the buyer site's menu), with the request's context unchanged. Any refusal or
 * failure is `null`.
 */
export class FacadeCategorySubtree implements CategorySubtreeSource {
  constructor(private readonly catalog: CatalogAssistantFacade) {}

  async subtreeOf(
    context: CallContext,
    categoryId: Id<'Category'>,
  ): Promise<readonly Id<'Category'>[] | null> {
    try {
      const tree = await this.catalog.categories(context);
      return tree.ok ? categorySubtree(tree.value, categoryId) : null;
    } catch {
      return null;
    }
  }
}
