import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  CategoryTreeUnavailableError,
  liveCategoryTree,
  MAX_TREE_NODES,
  type StoredCategoryNode,
} from './category-tree';

// The live category tree (pure): only active categories, each under its nearest live ancestor,
// depth first with siblings by name in the locale, and fail closed on a tree it cannot build.

const id = (n: number): Id<'Category'> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Category'>;
};

const node = (
  n: number,
  parent: number | null,
  name: string,
  extra: Partial<StoredCategoryNode> = {},
): StoredCategoryNode => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  status: 'active',
  mergedIntoId: null,
  slug: `c-${n}`,
  names: [{ locale: 'en-AU', name }],
  ...extra,
});

describe.each(['en-AU', 'ja-JP'])('live category tree (locale %s)', (locale) => {
  const named = (n: number, parent: number | null, name: string) =>
    node(n, parent, name, { names: [{ locale, name }] });

  it('lists the tree depth first, siblings by name then id, with depth and position', () => {
    const tree = liveCategoryTree(
      [named(1, null, 'Meat'), named(2, null, 'Bakery'), named(3, 1, 'Lamb'), named(4, 1, 'Beef')],
      locale,
    );

    expect(tree.map((c) => [c.slug, c.parentId, c.depth, c.position])).toEqual([
      ['c-2', null, 0, 0],
      ['c-1', null, 0, 1],
      ['c-4', id(1), 1, 0],
      ['c-3', id(1), 1, 1],
    ]);
  });

  it('skips an archived ancestor and follows a merged one to its target', () => {
    const tree = liveCategoryTree(
      [
        named(1, null, 'Pantry'),
        node(2, 1, 'Old', { status: 'archived', names: [] }),
        named(3, 2, 'Spices'),
        named(4, null, 'Drinks'),
        node(5, null, 'Beverages', { status: 'merged', mergedIntoId: id(4), names: [] }),
        named(6, 5, 'Tea'),
      ],
      locale,
    );

    expect(tree.find((c) => c.slug === 'c-3')?.parentId).toBe(id(1));
    expect(tree.find((c) => c.slug === 'c-6')?.parentId).toBe(id(4));
    expect(tree.map((c) => c.slug)).not.toContain('c-2');
    expect(tree.map((c) => c.slug)).not.toContain('c-5');
  });

  it('uses the locale name, else the first locale in code order, and drops a nameless node', () => {
    const tree = liveCategoryTree(
      [
        node(1, null, 'x', {
          names: [
            { locale: 'zz-ZZ', name: 'Last' },
            { locale: 'ar-SA', name: 'First' },
          ],
        }),
        node(2, null, 'x', { names: [] }),
        named(3, 2, 'Child of nameless'),
      ],
      locale,
    );

    expect(tree.map((c) => c.name)).toEqual(['First']);
  });

  it('refuses a missing ancestor, a merge without a target and a tree that is too large', () => {
    expect(() => liveCategoryTree([named(1, 99, 'Orphan')], locale)).toThrow(
      CategoryTreeUnavailableError,
    );
    expect(() =>
      liveCategoryTree(
        [node(1, null, 'm', { status: 'merged', names: [] }), named(2, 1, 'Child')],
        locale,
      ),
    ).toThrow(CategoryTreeUnavailableError);
    const many = Array.from({ length: MAX_TREE_NODES + 1 }, (_, n) => named(n + 1, null, `n${n}`));
    expect(() => liveCategoryTree(many, locale)).toThrow(CategoryTreeUnavailableError);
  });

  it('refuses a loop through non-live ancestors', () => {
    expect(() =>
      liveCategoryTree(
        [
          node(1, 2, 'a', { status: 'archived', names: [] }),
          node(2, 1, 'b', { status: 'archived', names: [] }),
          named(3, 1, 'Leaf'),
        ],
        locale,
      ),
    ).toThrow(CategoryTreeUnavailableError);
  });
});
