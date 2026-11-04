import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  CategoryAttributeLinkStore,
  StoredLinkFact,
} from '../../src/modules/catalog/application/ports/category-attribute-link.store';
import type { CategoryTreeReader } from '../../src/modules/catalog/application/ports/category-tree.reader';
import type { CategoryAttributeLink } from '../../src/modules/catalog/domain/category-attribute-link';
import type { StoredCategoryNode } from '../../src/modules/catalog/domain/category-tree';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

// In-memory ports of the category attribute links (attributes package A4, categories C8) for the
// HTTP tests. The SQL is proved in test/db/catalog-category-links.db-spec.ts.

/** The category tree of each Market, set by hand. */
export class MemoryCategoryTree implements CategoryTreeReader {
  readonly nodesOf = new Map<string, StoredCategoryNode[]>();

  reset(): void {
    this.nodesOf.clear();
  }

  seed(marketId: string, node: Omit<StoredCategoryNode, 'mergedIntoId' | 'names' | 'slug'>): void {
    const list = this.nodesOf.get(marketId) ?? [];
    list.push({ ...node, mergedIntoId: null, names: [], slug: node.id });
    this.nodesOf.set(marketId, list);
  }

  nodes(market: MarketContext, limit: number) {
    return Promise.resolve((this.nodesOf.get(market.marketId) ?? []).slice(0, limit));
  }
}

/** Links in memory, per Market, with the same version rule as the SQL store. */
export class MemoryCategoryAttributeLinkStore implements CategoryAttributeLinkStore {
  readonly rows = new Map<string, CategoryAttributeLink>();
  readonly authors: { revisionId: string; author: string }[] = [];

  constructor(private readonly tree: MemoryCategoryTree) {}

  reset(): void {
    this.rows.clear();
    this.authors.length = 0;
  }

  private key(market: MarketContext, categoryId: string): string {
    return `${market.marketId}:${categoryId}`;
  }

  find(market: MarketContext, categoryId: Id<'Category'>) {
    return Promise.resolve(this.rows.get(this.key(market, categoryId)) ?? null);
  }

  all(market: MarketContext, limit: number): Promise<readonly StoredLinkFact[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.state.marketId === market.marketId)
        .slice(0, limit)
        .map((row) => ({
          categoryId: row.state.categoryId,
          familyId: row.state.familyId,
          filters: row.state.filters,
        })),
    );
  }

  categoryStatus(market: MarketContext, categoryId: Id<'Category'>) {
    const node = (this.tree.nodesOf.get(market.marketId) ?? []).find((n) => n.id === categoryId);
    return Promise.resolve(node?.status ?? null);
  }

  add(market: MarketContext, link: CategoryAttributeLink, author: Id<'Account'>) {
    const key = this.key(market, link.state.categoryId);
    if (this.rows.has(key)) throw new StaleAggregateError('category-links', link.state.categoryId);
    this.rows.set(key, link);
    this.authors.push({ revisionId: link.state.revisionId, author });
    return Promise.resolve();
  }

  saveRevision(market: MarketContext, link: CategoryAttributeLink, author: Id<'Account'>) {
    const key = this.key(market, link.state.categoryId);
    if (this.rows.get(key)?.state.version !== link.state.version - 1) {
      throw new StaleAggregateError('category-links', link.state.categoryId);
    }
    this.rows.set(key, link);
    this.authors.push({ revisionId: link.state.revisionId, author });
    return Promise.resolve();
  }
}
