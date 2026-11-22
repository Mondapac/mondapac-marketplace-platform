import type { CallContext } from '@mondapac/shared-kernel';
import type { CatalogIndexFacade } from '../../catalog';
import type { CategoryTreeSource } from '../application/ports/category-tree';
import type { NamedCategory } from '../domain/scope-counts';

/**
 * {@link CategoryTreeSource} over catalog's live category tree (`CatalogIndexFacade.categoryTree`,
 * an `anonymous` / `system` pair, so both a buyer's request and search's event handlers and
 * rebuild get it), with the context unchanged. Any refusal or failure is `null`.
 */
export class FacadeCategoryTree implements CategoryTreeSource {
  constructor(private readonly catalog: CatalogIndexFacade) {}

  async tree(context: CallContext): Promise<readonly NamedCategory[] | null> {
    try {
      const tree = await this.catalog.categoryTree(context);
      return tree.ok ? tree.value.map(({ id, parentId, name }) => ({ id, parentId, name })) : null;
    } catch {
      return null;
    }
  }
}
