import type { Id } from '@mondapac/shared-kernel';
import { countScope, MAX_SCOPE_ROWS, type NamedCategory, type ScopeRow } from './scope-counts';

const id = <T extends string>(n: number): Id<T> =>
  `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<T>;
const cat = (n: number) => id<'Category'>(n);
const product = (n: number) => id<'Product'>(100 + n);
const seller = (n: number) => id<'Seller'>(200 + n);

// 1 Meat > 2 Beef > 3 Mince;  4 Pantry;  5 Orphan (not in the tree)
const tree: NamedCategory[] = [
  { id: cat(1), parentId: null, name: 'Meat' },
  { id: cat(2), parentId: cat(1), name: 'Beef' },
  { id: cat(3), parentId: cat(2), name: 'Mince' },
  { id: cat(4), parentId: null, name: 'Pantry' },
];
const row = (p: number, s: number, ...categories: number[]): ScopeRow => ({
  productId: product(p),
  sellerId: seller(s),
  categoryIds: categories.map(cat),
});

describe('countScope', () => {
  it('counts products once however many sellers offer them, and distinct stores', () => {
    const counts = countScope([row(1, 1, 3), row(1, 2, 3), row(2, 1, 4)], tree, null);
    expect(counts.total).toBe(2);
    expect(counts.storeCount).toBe(2);
    expect(counts.totalIsCapped).toBe(false);
  });

  it('rolls a deep product up into the line right below the asked category', () => {
    const rows = [row(1, 1, 3), row(2, 1, 2), row(3, 1, 4)];
    const top = countScope(rows, tree, null);
    expect(top.categoryCounts).toEqual([
      { categoryId: cat(1), name: 'Meat', count: 2 },
      { categoryId: cat(4), name: 'Pantry', count: 1 },
    ]);
    const inMeat = countScope(rows.slice(0, 2), tree, cat(1));
    expect(inMeat.categoryCounts).toEqual([{ categoryId: cat(2), name: 'Beef', count: 2 }]);
  });

  it('counts a product once in a line even when two of its categories roll up into it', () => {
    const counts = countScope([row(1, 1, 2, 3)], tree, cat(1));
    expect(counts.categoryCounts).toEqual([{ categoryId: cat(2), name: 'Beef', count: 1 }]);
  });

  it('gives no line for a category the live tree does not hold', () => {
    const counts = countScope([row(1, 1, 5)], tree, null);
    expect(counts.categoryCounts).toEqual([]);
    expect(counts.total).toBe(1);
  });

  it('says so when the scope was cut at the cap', () => {
    const rows = Array.from({ length: MAX_SCOPE_ROWS + 1 }, (_, n) => row(n, 1, 4));
    const counts = countScope(rows, tree, null);
    expect(counts.totalIsCapped).toBe(true);
    expect(counts.total).toBe(MAX_SCOPE_ROWS);
  });
});
