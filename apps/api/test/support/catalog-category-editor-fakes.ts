import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  CategoryChange,
  CategoryEditStore,
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

  reset(): void {
    this.rows = new Map();
    this.revisions.length = 0;
    this.retired.length = 0;
    this.heldSlugs.clear();
    this.lockedSlugs.length = 0;
    this.facts.clear();
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
