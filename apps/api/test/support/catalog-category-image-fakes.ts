import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  CategoryImageOwner,
  CategoryImageStore,
  NewCategoryImage,
  StoredCategoryImage,
} from '../../src/modules/catalog/application/ports/category-image.store';
import type { CategoryStatus } from '../../src/modules/catalog/domain/platform-category';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

// An in-memory category image store (categories package C3c) for the use case and HTTP tests. The
// SQL is proved in test/db/catalog-category-image.db-spec.ts.

export interface CategoryImageRow {
  status: CategoryStatus;
  version: number;
  image: (NewCategoryImage & { readonly categoryId: Id<'Category'> }) | null;
}

/** The category rows of one Market and their images; `replace` follows the SQL order. */
export class MemoryCategoryImages implements CategoryImageStore {
  rows = new Map<Id<'Category'>, CategoryImageRow>();
  failNextReplace = false;

  reset(): void {
    this.rows = new Map();
    this.failNextReplace = false;
  }

  owner(_m: MarketContext, id: Id<'Category'>): Promise<CategoryImageOwner | null> {
    const row = this.rows.get(id);
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve({
      id,
      status: row.status,
      version: row.version,
      imageId: row.image?.id ?? null,
      revisionNo: 3,
      slug: 'dates',
    });
  }

  current(_m: MarketContext, id: Id<'Category'>): Promise<StoredCategoryImage | null> {
    const image = this.rows.get(id)?.image ?? null;
    return Promise.resolve(
      image === null
        ? null
        : { id: image.id, width: image.width, height: image.height, renditions: image.renditions },
    );
  }

  replace(_m: MarketContext, owner: CategoryImageOwner, image: NewCategoryImage | null) {
    const row = this.rows.get(owner.id);
    if (row === undefined || row.version !== owner.version) {
      return Promise.reject(new StaleAggregateError('platform-category', owner.id));
    }
    if (this.failNextReplace) {
      this.failNextReplace = false;
      return Promise.reject(new Error('database down'));
    }
    const old = row.image;
    row.version += 1;
    row.image = image === null ? null : { ...image, categoryId: owner.id };
    return Promise.resolve({
      version: row.version,
      removed:
        old === null
          ? null
          : { imageId: old.id, objectKeys: old.renditions.map((rendition) => rendition.objectKey) },
    });
  }
}
