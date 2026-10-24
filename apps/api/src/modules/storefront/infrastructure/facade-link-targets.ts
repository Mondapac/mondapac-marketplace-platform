import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogAssistantFacade } from '../../catalog';
import type { SellersFacade } from '../../sellers';
import type { LinkTargets, LiveCategoryRow } from '../application/ports/link-targets';

const BATCH = 100;

/**
 * {@link LinkTargets} over the facades of catalog and sellers, each called with the request's
 * context unchanged, so every answer is of the request's Market. Any refusal or failure is null:
 * the caller drops what depends on it.
 */
export class FacadeLinkTargets implements LinkTargets {
  constructor(
    private readonly categoryTree: CatalogAssistantFacade,
    private readonly sellers: SellersFacade,
  ) {}

  async categories(context: CallContext): Promise<readonly LiveCategoryRow[] | null> {
    try {
      const answer = await this.categoryTree.categories(context);
      return answer.ok
        ? answer.value.map(({ id, parentId, slug }) => ({ id, parentId, slug }))
        : null;
    } catch {
      return null;
    }
  }

  async sellerSlugs(
    context: CallContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string> | null> {
    const slugs = new Map<string, string>();
    try {
      const sellerIds: Id<'Seller'>[] = [];
      for (const id of ids) {
        const parsed = parseId(id);
        if (parsed.ok) sellerIds.push(parsed.value as Id<'Seller'>);
      }
      for (let from = 0; from < sellerIds.length; from += BATCH) {
        const answer = await this.sellers.publishedStoreSlugs(
          context,
          sellerIds.slice(from, from + BATCH),
        );
        if (!answer.ok) return null;
        for (const [sellerId, slug] of answer.value) slugs.set(sellerId, slug);
      }
    } catch {
      return null;
    }
    return slugs;
  }
}
