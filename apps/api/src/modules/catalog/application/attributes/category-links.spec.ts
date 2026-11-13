import type { Id } from '@mondapac/shared-kernel';
import type { StoredLinkFact } from '../ports/category-attribute-link.store';
import {
  chainOf,
  effectiveFeatureSetsOf,
  effectiveOf,
  type CategoryParentNode,
} from './category-links';

// The batched resolution of a whole tree's feature sets gives, for every category, exactly what
// the one-category resolution (`effectiveOf`, used by `category-attribute-links.get`) gives, and
// fails closed on a tree whose chains cannot be read.

const cat = (n: number) =>
  `01990000-0000-7000-8000-${(0xc00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;
const family = (n: number) =>
  `01990000-0000-7000-8000-${(0xfa00 + n).toString(16).padStart(12, '0')}` as Id<'AttributeFamily'>;
const node = (n: number, parent: number | null): CategoryParentNode => ({
  id: cat(n),
  parentId: parent === null ? null : cat(parent),
});

describe('effectiveFeatureSetsOf', () => {
  const nodes = [node(1, null), node(2, 1), node(3, 2), node(4, 2), node(5, null)];
  const links: StoredLinkFact[] = [
    { categoryId: cat(1), familyId: family(1), filters: ['colour'] },
    { categoryId: cat(2), familyId: null, filters: ['size'] },
    { categoryId: cat(4), familyId: family(2), filters: [] },
  ];

  it('matches the one-category resolution for every category', () => {
    const all = effectiveFeatureSetsOf(nodes, links);
    expect(all).not.toBeNull();
    for (const { id } of nodes) {
      const one = effectiveOf(chainOf(id, nodes)!, links);
      expect(all!.get(id)).toEqual({
        familyId: one.familyId,
        fromCategoryId: one.familyFromCategoryId,
      });
    }
    expect(all!.get(cat(3))).toEqual({ familyId: family(1), fromCategoryId: cat(1) });
    expect(all!.get(cat(4))).toEqual({ familyId: family(2), fromCategoryId: cat(4) });
    expect(all!.get(cat(5))).toEqual({ familyId: null, fromCategoryId: null });
  });

  it('is null for a tree with a loop or a missing parent', () => {
    expect(effectiveFeatureSetsOf([node(1, 2), node(2, 1)], links)).toBeNull();
    expect(effectiveFeatureSetsOf([node(1, 9)], links)).toBeNull();
  });
});
