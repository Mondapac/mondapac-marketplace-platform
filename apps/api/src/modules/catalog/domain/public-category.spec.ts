import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { liveCategoryTree, type StoredCategoryNode } from './category-tree';
import {
  publicCategoryTree,
  resolveCategorySlug,
  type PublicCategoryDetails,
} from './public-category';

// The buyer site's category tree and the `/c/{slug}` resolver (categories C6a): the menu flags,
// "has live products" folded up the tree, texts with the default-locale fallback, and redirects
// that are always one hop to a slug, never a loop and never a URL.

const id = (n: number): Id<'Category'> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Category'>;
};

const node = (
  n: number,
  parent: number | null,
  extra: Partial<StoredCategoryNode> = {},
): StoredCategoryNode => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  status: 'active',
  mergedIntoId: null,
  slug: `c-${n}`,
  position: n,
  names: [{ locale: 'en-AU', name: `Category ${n}` }],
  ...extra,
});

const details = (extra: Partial<PublicCategoryDetails> = {}): PublicCategoryDetails => ({
  showInMenu: true,
  seo: { title: null, description: null, noindex: false },
  shortDescriptions: new Map(),
  ...extra,
});

describe('public category tree', () => {
  const nodes = [
    node(1, null),
    node(2, 1),
    node(3, 2),
    node(4, 2),
    node(5, null),
    node(6, 5),
    node(7, null),
    node(8, 7),
  ];
  const live = liveCategoryTree(nodes, 'en-AU');

  it('folds live products up to every ancestor and keeps empty branches out of the menu', () => {
    const counts = new Map([
      [id(3), 1],
      [id(6), 1],
    ]);
    const tree = publicCategoryTree(live, new Map(), counts, 'en-AU', 'en-AU');
    const flags = new Map(tree.map((c) => [c.slug, [c.hasLiveProducts, c.inMenu]]));

    expect(flags.get('c-1')).toEqual([true, true]);
    expect(flags.get('c-2')).toEqual([true, true]);
    expect(flags.get('c-3')).toEqual([true, true]);
    expect(flags.get('c-4')).toEqual([false, false]);
    expect(flags.get('c-5')).toEqual([true, true]);
    expect(flags.get('c-7')).toEqual([false, false]);
    expect(flags.get('c-8')).toEqual([false, false]);
  });

  it('counts live products per category, summed up the tree from the direct counts', () => {
    const tree = publicCategoryTree(
      live,
      new Map(),
      new Map([
        [id(1), 1],
        [id(3), 4],
        [id(4), 2],
        [id(6), 5],
        [id(99), 7],
      ]),
      'en-AU',
      'en-AU',
    );
    const counts = new Map(tree.map((c) => [c.slug, c.liveProductCount]));

    expect(Object.fromEntries(counts)).toEqual({
      'c-1': 7,
      'c-2': 6,
      'c-3': 4,
      'c-4': 2,
      'c-5': 5,
      'c-6': 5,
      'c-7': 0,
      'c-8': 0,
    });
  });

  it('flags a category switched out of the menu, and its children with it, without dropping them', () => {
    const tree = publicCategoryTree(
      live,
      new Map([[id(2), details({ showInMenu: false })]]),
      new Map([
        [id(3), 1],
        [id(4), 1],
      ]),
      'en-AU',
      'en-AU',
    );
    const bySlug = new Map(tree.map((c) => [c.slug, c]));

    expect(tree).toHaveLength(live.length);
    expect(bySlug.get('c-1')).toMatchObject({ inMenu: true, showInMenu: true });
    expect(bySlug.get('c-2')).toMatchObject({ inMenu: false, showInMenu: false });
    expect(bySlug.get('c-3')).toMatchObject({ inMenu: false, showInMenu: true });
    expect(bySlug.get('c-3')?.hasLiveProducts).toBe(true);
  });

  it('answers the short description in the locale, else the default locale, and the SEO fields', () => {
    const seo = { title: 'Halal meat', description: 'Fresh halal cuts', noindex: true };
    const tree = publicCategoryTree(
      live,
      new Map([
        [
          id(1),
          details({
            seo,
            shortDescriptions: new Map([
              ['en-AU', 'Fresh'],
              ['fa-IR', 'تازه'],
            ]),
          }),
        ],
        [id(5), details({ shortDescriptions: new Map([['en-AU', 'Pantry staples']]) })],
      ]),
      new Map(),
      'fa-IR',
      'en-AU',
    );
    const bySlug = new Map(tree.map((c) => [c.slug, c]));

    expect(bySlug.get('c-1')).toMatchObject({ shortDescription: 'تازه', seo, imageUrl: null });
    expect(bySlug.get('c-5')?.shortDescription).toBe('Pantry staples');
    expect(bySlug.get('c-7')?.shortDescription).toBeNull();
  });
});

describe('category slug resolver', () => {
  const noHistory = () => null;
  const resolve = (
    slug: string,
    nodes: readonly StoredCategoryNode[],
    history: (slug: string) => Id<'Category'> | null = noHistory,
  ) =>
    resolveCategorySlug(
      slug,
      nodes,
      new Set(liveCategoryTree(nodes, 'en-AU').map((c) => c.id)),
      history,
    );

  it('answers a live category by its own slug', () => {
    expect(resolve('c-2', [node(1, null), node(2, 1)])).toEqual({
      kind: 'category',
      id: id(2),
      slug: 'c-2',
    });
  });

  it('redirects a retired slug permanently to the category that retired it', () => {
    const nodes = [node(1, null, { slug: 'halal-meat' })];

    expect(resolve('meat', nodes, (slug) => (slug === 'meat' ? id(1) : null))).toEqual({
      kind: 'redirect',
      slug: 'halal-meat',
      permanent: true,
    });
  });

  it('collapses a chain A -> B -> C (history, merge, merge) into one permanent redirect', () => {
    const nodes = [
      node(1, null, { status: 'merged', mergedIntoId: id(2), slug: 'b', names: [] }),
      node(2, null, { status: 'merged', mergedIntoId: id(3), slug: 'b2', names: [] }),
      node(3, null, { slug: 'c' }),
    ];

    expect(resolve('a', nodes, () => id(1))).toEqual({
      kind: 'redirect',
      slug: 'c',
      permanent: true,
    });
    expect(resolve('b', nodes)).toEqual({ kind: 'redirect', slug: 'c', permanent: true });
  });

  it('follows an archived category to its parent permanently', () => {
    const nodes = [node(1, null), node(2, 1, { status: 'archived', names: [] })];

    expect(resolve('c-2', nodes)).toEqual({ kind: 'redirect', slug: 'c-1', permanent: true });
  });

  it('sends a hidden category, or one inside a hidden branch, temporarily to the nearest shown ancestor', () => {
    const nodes = [
      node(1, null),
      node(2, 1, { status: 'hidden' }),
      node(3, 2),
      node(4, null, { status: 'hidden' }),
    ];

    expect(resolve('c-2', nodes)).toEqual({ kind: 'redirect', slug: 'c-1', permanent: false });
    expect(resolve('c-3', nodes)).toEqual({ kind: 'redirect', slug: 'c-1', permanent: false });
    // A hidden top-level category has no shown ancestor.
    expect(resolve('c-4', nodes)).toEqual({ kind: 'not-found' });
  });

  it('keeps a redirect temporary when an archived category sits under a hidden one', () => {
    const nodes = [
      node(1, null),
      node(2, 1, { status: 'hidden' }),
      node(3, 2, { status: 'archived', names: [] }),
    ];

    expect(resolve('c-3', nodes)).toEqual({ kind: 'redirect', slug: 'c-1', permanent: false });
  });

  it('keeps a redirect temporary when a merge leads into a hidden category', () => {
    const nodes = [
      node(1, null),
      node(2, 1, { status: 'hidden' }),
      node(3, null, { status: 'merged', mergedIntoId: id(2), names: [] }),
    ];

    expect(resolve('c-3', nodes)).toEqual({ kind: 'redirect', slug: 'c-1', permanent: false });
  });

  it('answers not found for a merge loop, a missing target and a history row of an unknown id', () => {
    const loop = [
      node(1, null, { status: 'merged', mergedIntoId: id(2), names: [] }),
      node(2, null, { status: 'merged', mergedIntoId: id(1), names: [] }),
    ];

    expect(resolve('c-1', loop)).toEqual({ kind: 'not-found' });
    expect(resolve('c-1', [node(1, null, { status: 'merged', names: [] })])).toEqual({
      kind: 'not-found',
    });
    expect(resolve('gone', [node(1, null)], () => id(99))).toEqual({ kind: 'not-found' });
    expect(resolve('nothing', [node(1, null)])).toEqual({ kind: 'not-found' });
  });

  it.each([
    '//evil.com',
    '%2F%2Fevil.com',
    '\\\\evil.com',
    'https://evil.com',
    'Meat',
    'meat/lamb',
    '',
    '-meat',
  ])('answers not found for %j without reading the history', (slug) => {
    const history = jest.fn(() => id(1));

    expect(resolve(slug, [node(1, null)], history)).toEqual({ kind: 'not-found' });
    expect(history).not.toHaveBeenCalled();
  });

  it('never answers a redirect target that is not a slug', () => {
    const nodes = [
      node(1, null, { slug: '//evil.com' }),
      node(2, null, { status: 'merged', mergedIntoId: id(1), names: [] }),
    ];

    expect(resolve('c-2', nodes)).toEqual({ kind: 'not-found' });
  });
});
