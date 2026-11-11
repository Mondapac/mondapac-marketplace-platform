import { checkProductCategories, type ProductCategoryNode } from './product-category-rules';

const n = (id: string, parentId: string | null, status = 'active'): ProductCategoryNode => ({
  id,
  parentId,
  status,
});
// d (1) > g (2) > c (3) > s (4); h hidden at level 3; a archived at level 3
const tree = [
  n('d', null),
  n('g', 'd'),
  n('c', 'g'),
  n('s', 'c'),
  n('h', 'g', 'hidden'),
  n('a', 'g', 'archived'),
  n('c2', 'g'),
  n('c3', 'g'),
  n('c4', 'g'),
];

describe('checkProductCategories', () => {
  it('accepts levels 3 and 4, active or hidden', () => {
    expect(checkProductCategories(tree, ['c', 's', 'h'], 4)).toEqual([]);
  });
  it('requires at least one and refuses more than three', () => {
    expect(checkProductCategories(tree, [], 4)).toEqual([
      { path: 'categoryIds', code: 'required' },
    ]);
    expect(checkProductCategories(tree, ['c', 'c2', 'c3', 'c4'], 4)).toEqual([
      { path: 'categoryIds', code: 'too-many' },
    ]);
  });
  it('refuses a department and a group', () => {
    expect(checkProductCategories(tree, ['d', 'g'], 4)).toEqual([
      { path: 'categoryIds.0', code: 'category.level-not-allowed' },
      { path: 'categoryIds.1', code: 'category.level-not-allowed' },
    ]);
  });
  it('refuses level 4 where the Market allows depth 3 (ZZ)', () => {
    expect(checkProductCategories(tree, ['s'], 3)).toEqual([
      { path: 'categoryIds.0', code: 'category.level-not-allowed' },
    ]);
    expect(checkProductCategories(tree, ['c'], 3)).toEqual([]);
  });
  it('refuses archived, unknown and repeated ids', () => {
    expect(checkProductCategories(tree, ['a', 'zz', 'c'], 4)).toEqual([
      { path: 'categoryIds.0', code: 'category.not-available' },
      { path: 'categoryIds.1', code: 'unknown' },
    ]);
    expect(checkProductCategories(tree, ['c', 'c'], 4)).toEqual([
      { path: 'categoryIds.1', code: 'duplicate' },
    ]);
  });
  it('treats a broken chain as level 0 (not allowed)', () => {
    expect(checkProductCategories([n('x', 'missing')], ['x'], 4)).toEqual([
      { path: 'categoryIds.0', code: 'category.level-not-allowed' },
    ]);
  });
});
