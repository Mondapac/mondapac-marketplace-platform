import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogAssistantFacade, CatalogFacade } from '../../catalog';
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
    private readonly catalog: CatalogFacade,
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

  async liveProducts(
    context: CallContext,
    ids: readonly string[],
  ): Promise<ReadonlySet<string> | null> {
    const live = new Set<string>();
    try {
      for (const id of ids) {
        const parsed = parseId(id);
        if (!parsed.ok) continue;
        // Existence only: the name is not used, so any locale will do (INTL-13 fallback).
        const answer = await this.catalog.publishedProduct(
          context,
          parsed.value as Id<'Product'>,
          'en',
        );
        if (!answer.ok) return null;
        if (answer.value !== null) live.add(id);
      }
    } catch {
      return null;
    }
    return live;
  }

  async sellerSlugs(
    context: CallContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string> | null> {
    const slugs = new Map<string, string>();
    try {
      const sellerIds = ids.flatMap((id) => {
        const parsed = parseId(id);
        return parsed.ok ? [parsed.value] : [];
      });
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
