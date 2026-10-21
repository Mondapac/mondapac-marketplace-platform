import { describe, expect, it, vi } from 'vitest';
import {
  categoryOf,
  findInTree,
  slugsOf,
  topCategories,
  treeOf,
} from '../src/storefront/category-tree.ts';
import { navigationOf } from '../src/storefront/navigation.ts';
import type { ApiRead } from '../src/storefront/api.ts';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';
import { loadShellContent, shellFrom } from '../src/storefront/shell-source.ts';

const MEAT = '0b5e1c3a-0000-4000-8000-000000000001';
const LAMB = '0b5e1c3a-0000-4000-8000-000000000002';
const BAKERY = '0b5e1c3a-0000-4000-8000-000000000003';
const GONE = '0b5e1c3a-0000-4000-8000-0000000000ff';

/** The live tree as `GET catalog/categories` answers it: depth first. */
const TREE = {
  locale: 'en',
  categories: [
    { id: MEAT, parentId: null, slug: 'meat', name: 'Meat', depth: 0, position: 0 },
    { id: LAMB, parentId: MEAT, slug: 'lamb', name: 'Lamb', depth: 1, position: 0 },
    { id: BAKERY, parentId: null, slug: 'bakery', name: 'Bakery', depth: 0, position: 1 },
  ],
};

const nav = (slots: Record<string, unknown[]>) => ({
  kind: 'page',
  page: {
    key: 'navigation',
    slots: Object.entries(slots).map(([key, modules]) => ({ key, kind: 'modules', modules })),
  },
});
const entry = (categoryId: unknown, label?: string, module = 'nav-category') => ({
  id: `m-${String(categoryId)}`,
  module,
  config: { categoryId, ...(label === undefined ? {} : { label }) },
});
const EMPTY_NAV = nav({ rail: [], 'drawer-popular': [], 'drawer-categories': [] });
const ok = (body: unknown): ApiRead<unknown> => ({ kind: 'ok', body });
const FAILED: ApiRead<unknown> = { kind: 'failed', status: 500 };

describe('category tree', () => {
  const rows = treeOf(TREE)!;

  it('keeps valid rows and drops a bad one or a repeat', () => {
    const body = {
      categories: [
        ...TREE.categories,
        { id: 'not-a-uuid', parentId: null, slug: 'x', name: 'X' },
        { id: GONE, parentId: null, slug: 'Bad Slug', name: 'Bad' },
        { id: GONE, parentId: 7, slug: 'seven', name: 'Seven' },
        { id: GONE, parentId: null, slug: 'nameless', name: '  ' },
        { id: MEAT, parentId: null, slug: 'again', name: 'Again' },
        'junk',
      ],
    };
    expect(treeOf(body)!.map((r) => r.slug)).toEqual(['meat', 'lamb', 'bakery']);
  });

  it('is not a tree when the body has no category list', () => {
    expect(treeOf(null)).toBeNull();
    expect(treeOf({ categories: 'x' })).toBeNull();
    expect(treeOf({ categories: [] })).toEqual([]);
  });

  it('builds the top level with direct children and the slug of each id', () => {
    expect(topCategories(rows)).toEqual([
      {
        code: 'meat',
        name: 'Meat',
        shortName: 'Meat',
        children: [{ code: 'lamb', name: 'Lamb' }],
      },
      { code: 'bakery', name: 'Bakery', shortName: 'Bakery', children: [] },
    ]);
    expect(slugsOf(rows).get(LAMB)).toBe('lamb');
    expect(categoryOf(rows, rows[0]!, 'Fresh meat').name).toBe('Fresh meat');
  });

  it('finds a slug, its child and nothing for an unknown one', () => {
    expect(findInTree(rows, 'meat')?.node.id).toBe(MEAT);
    expect(findInTree(rows, 'meat', 'lamb')?.child?.id).toBe(LAMB);
    expect(findInTree(rows, 'lamb')?.node.id).toBe(LAMB);
    expect(findInTree(rows, 'meat', 'bakery')).toBeUndefined();
    expect(findInTree(rows, 'nope')).toBeUndefined();
  });
});

describe('approved navigation', () => {
  const rows = treeOf(TREE)!;

  it('reads the drawer slots in order, with labels, and ignores the rail', () => {
    const body = nav({
      rail: [{ id: 'r', module: 'nav-link', config: { label: 'Offers' } }],
      'drawer-popular': [entry(BAKERY, 'Fresh bread'), entry(MEAT)],
      'drawer-categories': [entry(BAKERY), entry(MEAT, 'Butcher')],
    });
    const result = navigationOf(body, rows)!;
    expect(result.categories.map((c) => c.name)).toEqual(['Bakery', 'Butcher']);
    expect(result.categories[1]?.children).toEqual([{ code: 'lamb', name: 'Lamb' }]);
    expect(result.popular).toEqual(['Fresh bread', 'Meat']);
  });

  it('drops an entry whose category is gone, a repeat and a malformed entry', () => {
    const body = nav({
      'drawer-categories': [
        entry(GONE),
        entry(MEAT),
        entry(MEAT, 'Again'),
        entry(7),
        entry(BAKERY, undefined, 'banner'),
        'junk',
      ],
    });
    expect(navigationOf(body, rows)!.categories.map((c) => c.code)).toEqual(['meat']);
  });

  it('is empty before an admin approves one, and not a navigation when the body is not a page', () => {
    expect(navigationOf(EMPTY_NAV, rows)).toEqual({ categories: [], popular: [] });
    expect(navigationOf({ kind: 'redirect', to: '/' }, rows)).toBeNull();
    expect(navigationOf('x', rows)).toBeNull();
  });
});

describe('shell content', () => {
  const approved = nav({
    'drawer-popular': [entry(MEAT, 'Halal meat')],
    'drawer-categories': [entry(BAKERY)],
  });

  it('uses the approved navigation, then keeps the sample sellers and delivery area', () => {
    const shell = shellFrom({ tree: ok(TREE), navigation: ok(approved) }, true);
    expect(shell.categories.map((c) => c.code)).toEqual(['bakery']);
    expect(shell.popularSearches).toEqual(['Halal meat']);
    expect(shell.sellers).toBe(SAMPLE_CONTENT.sellers);
    expect(shell.delivery).toBe(SAMPLE_CONTENT.delivery);
  });

  it('uses the live tree when the navigation is empty, never the sample categories', () => {
    for (const fallback of [true, false]) {
      const shell = shellFrom({ tree: ok(TREE), navigation: ok(EMPTY_NAV) }, fallback);
      expect(shell.categories.map((c) => c.code)).toEqual(['meat', 'bakery']);
    }
  });

  it('takes the sample only while the fallback is on, for what the API gives nothing of', () => {
    const empty = { tree: ok({ categories: [] }), navigation: ok(EMPTY_NAV) };
    expect(shellFrom(empty, true).categories).toBe(SAMPLE_CONTENT.categories);
    expect(shellFrom(empty, true).popularSearches).toBe(SAMPLE_CONTENT.popularSearches);
    expect(shellFrom(empty, false).categories).toEqual([]);
    expect(shellFrom(empty, false).popularSearches).toEqual([]);
    // The tree beside an empty navigation still gives popular searches the sample's words.
    expect(shellFrom({ tree: ok(TREE), navigation: ok(EMPTY_NAV) }, false).popularSearches).toEqual(
      [],
    );
  });

  it('falls back when a read fails or the body is not what it should be', () => {
    expect(shellFrom({ tree: FAILED, navigation: FAILED }, true).categories).toBe(
      SAMPLE_CONTENT.categories,
    );
    expect(shellFrom({ tree: FAILED, navigation: ok(approved) }, false).categories).toEqual([]);
    expect(shellFrom({ tree: ok('junk'), navigation: ok(approved) }, false).categories).toEqual([]);
    // Without the navigation the tree still serves the menu.
    expect(shellFrom({ tree: ok(TREE), navigation: FAILED }, false).categories).toHaveLength(2);
    expect(shellFrom({ tree: ok(TREE), navigation: ok('junk') }, true).categories).toHaveLength(2);
  });

  it('reads both routes, is the sample with the API off and logs a fallback', async () => {
    const paths: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const read = (path: string): Promise<ApiRead<unknown>> => {
      paths.push(path);
      return Promise.resolve(path === 'catalog/categories' ? ok(TREE) : FAILED);
    };
    const shell = await loadShellContent(read, { STOREFRONT_SAMPLE_DATA: 'off' });
    expect(paths.sort()).toEqual(['catalog/categories', 'storefront/navigation']);
    expect(shell.categories.map((c) => c.code)).toEqual(['meat', 'bakery']);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ msg: 'storefront.shell-navigation-unusable' }),
    );
    log.mockClear();

    const off = (): Promise<ApiRead<unknown>> => Promise.resolve({ kind: 'off' });
    expect(await loadShellContent(off, {})).toBe(SAMPLE_CONTENT);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
