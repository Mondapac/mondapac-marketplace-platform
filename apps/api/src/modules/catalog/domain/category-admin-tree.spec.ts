import type { Id } from '@mondapac/shared-kernel';
import {
  adminCategoryTree,
  categoryImpact,
  categoryPath,
  type AdminStoredCategory,
  type CategoryProductFact,
} from './category-admin-tree';
import { CategoryTreeUnavailableError } from './category-tree';

const cat = (n: number): Id<'Category'> =>
  `01990000-0000-7000-8000-${(0xc00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;

const node = (
  n: number,
  parent: number | null,
  name: string,
  status: AdminStoredCategory['status'] = 'active',
): AdminStoredCategory => ({
  id: cat(n),
  parentId: parent === null ? null : cat(parent),
  slug: `c${n}`,
  status,
  mergedIntoId: null,
  names: [{ locale: 'en', name }],
  revisionNo: 1,
  version: 1,
});

// 1 Pantry > 2 Rice > 3 Basmati; 1 > 4 Spices; 5 Meat; 6 Old (archived, under 5).
const NODES = [
  node(1, null, 'Pantry'),
  node(2, 1, 'Rice'),
  node(3, 2, 'Basmati'),
  node(4, 1, 'Spices'),
  node(5, null, 'Meat'),
  node(6, 5, 'Old', 'archived'),
];

const fact = (categories: number[], offers = 1, listed = 1, tagged = 0): CategoryProductFact => ({
  categoryIds: categories.map(cat),
  offers,
  listedOffers: listed,
  offersWithActiveTag: tagged,
});

describe('adminCategoryTree', () => {
  it('lists every status depth first, siblings by name, with depth and position', () => {
    const rows = adminCategoryTree(NODES, 'en', []);
    expect(rows.map((r) => [r.slug, r.depth, r.position])).toEqual([
      ['c5', 0, 0], // Meat
      ['c6', 1, 0],
      ['c1', 0, 1], // Pantry
      ['c2', 1, 0],
      ['c3', 2, 0],
      ['c4', 1, 1],
    ]);
    expect(rows.find((r) => r.slug === 'c6')?.status).toBe('archived');
  });

  it('counts a product once in every category of its subtree, even with two categories there', () => {
    const rows = adminCategoryTree(NODES, 'en', [fact([3, 2]), fact([4]), fact([3], 2, 0)]);
    const by = (n: number) => rows.find((r) => r.id === cat(n))!.counts;
    expect(by(1)).toEqual({ liveProducts: 2, liveProductsDirect: 0, offers: 4 });
    expect(by(2)).toEqual({ liveProducts: 1, liveProductsDirect: 1, offers: 3 });
    expect(by(3)).toEqual({ liveProducts: 1, liveProductsDirect: 1, offers: 3 });
    expect(by(4)).toEqual({ liveProducts: 1, liveProductsDirect: 1, offers: 1 });
    expect(by(5)).toEqual({ liveProducts: 0, liveProductsDirect: 0, offers: 0 });
  });

  it('does not count a product with no listed Offer as live, but counts its Offers', () => {
    const rows = adminCategoryTree(NODES, 'en', [fact([3], 2, 0)]);
    expect(rows.find((r) => r.id === cat(3))!.counts).toEqual({
      liveProducts: 0,
      liveProductsDirect: 0,
      offers: 2,
    });
  });

  it('ignores a fact that names a category the tree does not hold', () => {
    const rows = adminCategoryTree(NODES, 'en', [fact([99])]);
    expect(rows.every((r) => r.counts.liveProducts === 0)).toBe(true);
  });

  it('falls back to the first locale for the order when the wanted one has no name', () => {
    const rows = adminCategoryTree([node(1, null, 'B'), node(2, null, 'A')], 'zz', []);
    expect(rows.map((r) => r.slug)).toEqual(['c2', 'c1']);
  });

  it('refuses a missing parent, a loop and a tree that is too large', () => {
    expect(() => adminCategoryTree([node(2, 9, 'Lost')], 'en', [])).toThrow(
      CategoryTreeUnavailableError,
    );
    expect(() => adminCategoryTree([node(1, 2, 'A'), node(2, 1, 'B')], 'en', [])).toThrow(
      CategoryTreeUnavailableError,
    );
    const many = Array.from({ length: 5001 }, (_, i) => node(i + 1, null, `N${i}`));
    expect(() => adminCategoryTree(many, 'en', [])).toThrow(CategoryTreeUnavailableError);
  });
});

describe('categoryPath', () => {
  it('runs from the root to the category, and is empty for an unknown id', () => {
    expect(categoryPath(NODES, cat(3)).map((n) => n.slug)).toEqual(['c1', 'c2', 'c3']);
    expect(categoryPath(NODES, cat(99))).toEqual([]);
  });
});

describe('categoryImpact', () => {
  it('counts products, direct products, Offers, listed Offers, tagged Offers and descendants', () => {
    const facts = [
      fact([3], 2, 1, 1),
      fact([2], 1, 0, 0),
      fact([4], 5, 5, 5),
      fact([3, 2], 1, 1, 0),
    ];
    expect(categoryImpact(NODES, cat(2), facts)).toEqual({
      products: 3,
      directProducts: 2,
      offers: 4,
      listedOffers: 2,
      offersWithActiveTag: 1,
      descendants: 1,
    });
    expect(categoryImpact(NODES, cat(1), facts).products).toBe(4);
  });

  it('counts nothing for an unknown category', () => {
    expect(categoryImpact(NODES, cat(99), [fact([3])]).products).toBe(0);
  });
});
