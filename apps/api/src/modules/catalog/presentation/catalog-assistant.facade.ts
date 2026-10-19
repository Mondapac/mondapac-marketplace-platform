import type { CallContext } from '@mondapac/shared-kernel';
import type { CategoryTreeQuery } from '../application/use-cases/category-tree.use-case';
import type { CatalogAssistantFacade } from '../contracts/catalog-assistant.facade';

/** Passes the caller's `CallContext` unchanged to the public category tree, so the gate runs. */
export class CatalogAssistantFacadeImplementation implements CatalogAssistantFacade {
  constructor(private readonly tree: CategoryTreeQuery) {}

  async categories(context: CallContext) {
    const result = await this.tree.execute(context, {});
    if (!result.ok) return { ok: false, error: { code: 'catalog.categories-unavailable' } } as const;
    return {
      ok: true,
      value: result.value.categories.map(({ id, parentId, slug, name, depth }) => ({
        id,
        parentId,
        slug,
        name,
        depth,
      })),
    } as const;
  }
}
