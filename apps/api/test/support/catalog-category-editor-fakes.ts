import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  CategoryChange,
  CategoryEditStore,
  CategoryRestructureStore,
  NewCategory,
} from '../../src/modules/catalog/application/ports/category-edit.store';
import type { PlatformCategoryRepository } from '../../src/modules/catalog/application/ports/platform-category.repository';
import type { EditableCategory } from '../../src/modules/catalog/domain/category-edit';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

// In-memory ports of the category tree editor (categories package C3a) for the use-case specs
// and the HTTP tests. The SQL store is proved in test/db/catalog-category-editor.db-spec.ts.

export interface RecordedRevision {
  readonly categoryId: string;
  readonly kind: string;
  readonly revisionNo: number;
  readonly author: string;
}

/** A store in memory with the version rule of the SQL one. */
export class MemoryCategoryEditStore implements CategoryEditStore {
  rows = new Map<string, EditableCategory>();
  readonly revisions: RecordedRevision[] = [];
  readonly retired: { id: string; slug: string }[] = [];
  /** Slugs that count as retired from another category inside the last 12 months. */
  readonly heldSlugs = new Set<string>();
  /** Set per category id: the facts `discardFacts` answers. */
  readonly facts = new Map<string, { everShown: boolean; productRevisions: number }>();
  /** A merge's `merged_into_id`, per merged category (C4a). */
  readonly mergedInto = new Map<string, string>();
  /** The reason note of a revision, keyed `<categoryId>#<revisionNo>` (C4a). */
  readonly reasons = new Map<string, string>();

  reset(): void {
    this.rows = new Map();
    this.revisions.length = 0;
    this.retired.length = 0;
    this.heldSlugs.clear();
    this.lockedSlugs.length = 0;
    this.facts.clear();
    this.mergedInto.clear();
    this.reasons.clear();
  }

  put(category: EditableCategory): void {
    this.rows.set(category.id, category);
  }

  loadAll(): Promise<readonly EditableCategory[]> {
    return Promise.resolve([...this.rows.values()]);
  }

  /** The slugs locked, in the order asked (one list per call). */
  readonly lockedSlugs: string[][] = [];

  lockSlugs(_m: MarketContext, slugs: readonly string[]) {
    this.lockedSlugs.push([...new Set(slugs)].sort());
    return Promise.resolve();
  }

  slugUnavailable(_m: MarketContext, slug: string, exceptId: Id<'Category'> | null) {
    return Promise.resolve(
      this.heldSlugs.has(slug) ||
        [...this.rows.values()].some((row) => row.slug === slug && row.id !== exceptId),
    );
  }

  discardFacts(_m: MarketContext, id: Id<'Category'>) {
    return Promise.resolve(this.facts.get(id) ?? { everShown: false, productRevisions: 0 });
  }

  insert(_m: MarketContext, category: NewCategory) {
    const siblings = [...this.rows.values()].filter((row) => row.parentId === category.parentId);
    this.rows.set(category.id, {
      id: category.id,
      parentId: category.parentId,
      slug: category.slug,
      status: 'hidden',
      hiddenById: null,
      position: siblings.length === 0 ? 0 : Math.max(...siblings.map((s) => s.position)) + 1,
      version: 1,
      revisionNo: 1,
      createdByKind: 'admin',
      showInMenu: category.showInMenu,
      imageId: null,
      seo: category.seo,
      texts: category.texts,
    });
    this.revisions.push({
      categoryId: category.id,
      kind: 'created',
      revisionNo: 1,
      author: category.authorAccountId,
    });
    return Promise.resolve();
  }

  apply(_m: MarketContext, change: CategoryChange) {
    const current = this.rows.get(change.category.id);
    if (current === undefined || current.version !== change.category.version) {
      return Promise.reject(new StaleAggregateError('platform-category', change.category.id));
    }
    const { patch } = change;
    const next: EditableCategory = {
      ...current,
      version: current.version + 1,
      revisionNo: current.revisionNo + 1,
      texts: change.texts,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.hiddenById === undefined ? {} : { hiddenById: patch.hiddenById }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      ...(patch.parentId === undefined ? {} : { parentId: patch.parentId }),
      ...(patch.showInMenu === undefined ? {} : { showInMenu: patch.showInMenu }),
      ...(patch.imageId === undefined ? {} : { imageId: patch.imageId }),
      ...(patch.slug === undefined ? {} : { slug: patch.slug }),
      ...(patch.seo === undefined ? {} : { seo: patch.seo }),
    };
    this.rows.set(current.id, next);
    this.revisions.push({
      categoryId: current.id,
      kind: change.kind,
      revisionNo: next.revisionNo,
      author: change.authorAccountId,
    });
    if (patch.mergedIntoId !== undefined) this.mergedInto.set(current.id, patch.mergedIntoId);
    if (change.reason !== undefined)
      this.reasons.set(`${current.id}#${next.revisionNo}`, change.reason);
    return Promise.resolve(next.version);
  }

  retireSlug(_m: MarketContext, id: Id<'Category'>, slug: string) {
    this.retired.push({ id, slug });
    return Promise.resolve();
  }

  swapPositions(_m: MarketContext, a: EditableCategory, b: EditableCategory) {
    const first = this.rows.get(a.id)!;
    const second = this.rows.get(b.id)!;
    this.rows.set(a.id, { ...first, position: second.position });
    this.rows.set(b.id, { ...second, position: first.position });
    return Promise.resolve();
  }
}

/** The tree version row in memory, with the guarded bump of the SQL repository. */
export class MemoryTreeVersion implements Pick<
  PlatformCategoryRepository,
  'treeVersion' | 'bumpTreeVersion'
> {
  version = 1;

  treeVersion() {
    return Promise.resolve({ version: this.version });
  }

  bumpTreeVersion(_m: MarketContext, expected: number) {
    if (this.version !== expected) {
      return Promise.reject(new StaleAggregateError('category-tree', 'market'));
    }
    this.version += 1;
    return Promise.resolve();
  }
}

/**
 * The product reads of a move, merge or archive in memory (categories package C4a): products per
 * category as the specs set them. The SQL is proved in test/db/catalog-category-restructure.db-spec.ts.
 */
export class MemoryCategoryRestructureStore implements CategoryRestructureStore {
  /** Published products per category id: product id and its published revision id. */
  readonly products = new Map<string, { productId: string; revisionId: string }[]>();
  /** Products that name no other live platform category, per category id (AC 4). */
  readonly onlyHere = new Map<string, number>();
  /** Active tags per product id. */
  readonly activeTags = new Map<string, number>();
  readonly relinked: { from: string; to: string | null }[] = [];

  directProducts(_m: MarketContext, categoryIds: readonly Id<'Category'>[]) {
    const counts = new Map<string, number>();
    for (const id of categoryIds) {
      const found = this.products.get(id)?.length ?? 0;
      if (found > 0) counts.set(id, found);
    }
    return Promise.resolve(counts as ReadonlyMap<string, number>);
  }

  onlyCategoryProducts(_m: MarketContext, id: Id<'Category'>) {
    return Promise.resolve(this.onlyHere.get(id) ?? 0);
  }

  productsUnder(_m: MarketContext, categoryIds: readonly Id<'Category'>[], limit: number) {
    const seen = new Map<string, string>();
    for (const id of categoryIds) {
      for (const product of this.products.get(id) ?? [])
        seen.set(product.productId, product.revisionId);
    }
    const products = [...seen]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, limit)
      .map(([productId, revisionId]) => ({
        productId: productId as Id<'Product'>,
        revisionId: revisionId as Id<'ProductRevision'>,
      }));
    let activeTags = 0;
    for (const productId of seen.keys()) activeTags += this.activeTags.get(productId) ?? 0;
    return Promise.resolve({ products, activeTags });
  }

  relinkActivities(_m: MarketContext, from: Id<'Category'>, to: Id<'Category'> | null) {
    this.relinked.push({ from, to });
    return Promise.resolve(0);
  }
}
