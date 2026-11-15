import type { CallContext } from '@mondapac/shared-kernel';
import type { CatalogAssistantFacade } from '../../catalog';
import type { CategoryTreeSource } from '../application/ports/category-tree';
import type { NamedCategory } from '../domain/scope-counts';

/**
 * {@link CategoryTreeSource} over catalog's public category tree (rule `anonymous`), with the
 * context unchanged. Any refusal or failure is `null`.
 */
export class FacadeCategoryTree implements CategoryTreeSource {
  constructor(private readonly catalog: CatalogAssistantFacade) {}

  async tree(context: CallContext): Promise<readonly NamedCategory[] | null> {
    try {
      const tree = await this.catalog.categories(context);
      return tree.ok ? tree.value.map(({ id, parentId, name }) => ({ id, parentId, name })) : null;
    } catch {
      return null;
    }
  }
}
