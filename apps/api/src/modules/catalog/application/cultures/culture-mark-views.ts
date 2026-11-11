import type { Id } from '@mondapac/shared-kernel';
import type { LiveCategory } from '../../domain/category-tree';
import {
  resolveTreeMarks,
  type CertificationMark,
  type CultureCategoryRow,
} from '../../domain/culture-category';

/** One live category with a culture's own row (if any) and the effective values. */
export interface CultureCategoryMarkView {
  readonly categoryId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly depth: number;
  /** The culture's own row on this category, or null when it inherits everything. */
  readonly own: {
    readonly visible: boolean;
    /** null: the row leaves the mark to the nearest ancestor. */
    readonly certificationMark: CertificationMark | null;
  } | null;
  readonly effective: {
    readonly visible: boolean;
    readonly certificationMark: CertificationMark;
    readonly visibleSource: MarkSourceView;
    readonly markSource: MarkSourceView;
  };
}

export type MarkSourceView =
  | { readonly kind: 'default' }
  | { readonly kind: 'own' }
  | { readonly kind: 'inherited'; readonly fromCategoryId: string };

/** The marks of every live category of the tree, in the tree's own (depth first) order. */
export function markViewsOf(
  live: readonly LiveCategory[],
  rows: readonly CultureCategoryRow[],
): readonly CultureCategoryMarkView[] {
  const effective = resolveTreeMarks(live, rows);
  const own = new Map<Id<'Category'>, CultureCategoryRow>(rows.map((r) => [r.categoryId, r]));
  return live.map((category) => {
    const row = own.get(category.id);
    return {
      categoryId: category.id,
      parentId: category.parentId,
      name: category.name,
      depth: category.depth,
      own:
        row === undefined
          ? null
          : { visible: row.visible, certificationMark: row.certificationMark },
      effective: effective.get(category.id)!,
    };
  });
}
