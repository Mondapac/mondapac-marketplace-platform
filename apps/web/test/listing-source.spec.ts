import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRead } from '../src/storefront/api.ts';
import { liveCategory, liveProducts } from '../src/storefront/listing-source.ts';

const MEAT = '0b5e1c3a-0000-4000-8000-000000000001';
const LAMB = '0b5e1c3a-0000-4000-8000-000000000002';
const OFFER = '0b5e1c3a-0000-4000-8000-0000000000a1';
const SELLER = '0b5e1c3a-0000-4000-8000-0000000000b1';
const P1 = '0b5e1c3a-0000-4000-8000-0000000000c1';
const P2 = '0b5e1c3a-0000-4000-8000-0000000000c2';

const TREE = {
  locale: 'en',
  categories: [
    { id: MEAT, parentId: null, slug: 'meat', name: 'Meat', depth: 0, position: 0 },
    { id: LAMB, parentId: MEAT, slug: 'lamb', name: 'Lamb', depth: 1, position: 0 },
  ],
};

const item = (productId: string, name: unknown, categoryIds: unknown = [LAMB]) => ({
  offerId: OFFER,
  productId,
  sellerId: SELLER,
  name,
  shortText: null,
  categoryIds,
});

/** A reader that answers the tree and the search body, recording the paths it was asked. */
function reader(search: ApiRead<unknown>, tree: ApiRead<unknown> = { kind: 'ok', body: TREE }) {
  const paths: string[] = [];
  const read = (path: string): Promise<ApiRead<unknown>> => {
    paths.push(path);
    return Promise.resolve(path === 'catalog/categories' ? tree : search);
  };
  return { read, paths };
}

const PAGE = {
  items: [
    item(P1, 'Lamb shoulder, 1 kg'),
    item(P1, 'Lamb shoulder, 1 kg (second offer)'),
    item(P2, '   '),
    item(P2, 'Lamb cutlets', 'not-a-list'),
    { name: 'No ids' },
    'junk',
  ],
  page: 2,
  pageSize: 12,
  hasMore: true,
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('category of a URL', () => {
  it('is undefined with the API off, null for an unknown slug, else the tree node', async () => {
    const off = () => Promise.resolve<ApiRead<unknown>>({ kind: 'off' });
    expect(await liveCategory('meat', undefined, off)).toBeUndefined();
    const { read } = reader({ kind: 'off' });
    expect(await liveCategory('nope', undefined, read)).toBeNull();
    expect(await liveCategory('meat', 'beef', read)).toBeNull();
    expect(await liveCategory('meat', undefined, read)).toEqual({
      category: {
        code: 'meat',
        name: 'Meat',
        shortName: 'Meat',
        children: [{ code: 'lamb', name: 'Lamb' }],
      },
    });
    expect((await liveCategory('meat', 'lamb', read))?.child).toEqual({
      code: 'lamb',
      name: 'Lamb',
    });
  });

  it('throws when the tree cannot be read, so the page shows its error state', async () => {
    await expect(
      liveCategory(
        'meat',
        undefined,
        reader({ kind: 'off' }, { kind: 'failed', status: 500 }).read,
      ),
    ).rejects.toThrow('category tree');
    await expect(
      liveCategory('meat', undefined, reader({ kind: 'off' }, { kind: 'ok', body: 'x' }).read),
    ).rejects.toThrow('category tree');
  });
});

describe('products of a listing', () => {
  it('asks the route for the category id, the page and the page size and nothing else', async () => {
    const { read, paths } = reader({ kind: 'ok', body: PAGE });
    await liveProducts({ category: 'meat', subcategory: 'lamb', page: 2, pageSize: 12 }, read);
    expect(paths.at(-1)).toBe(`search/products?category=${LAMB}&page=2&pageSize=12`);
    await liveProducts({ category: 'meat', page: 1, pageSize: 12 }, read);
    expect(paths.at(-1)).toBe(`search/products?category=${MEAT}&page=1&pageSize=12`);
    await liveProducts({ q: 'lamb & rice', page: 1, pageSize: 12 }, read);
    expect(paths.at(-1)).toBe('search/products?q=lamb+%26+rice&page=1&pageSize=12');
  });

  it('turns items into cards without a price, seller name, seal or add button', async () => {
    const { read } = reader({ kind: 'ok', body: PAGE });
    const page = await liveProducts({ q: 'lamb', page: 2, pageSize: 12 }, read);
    expect(page?.hasMore).toBe(true);
    // The repeat of P1, the blank name and the non-objects are dropped; a bad category list
    // only loses the illustration.
    expect(page?.items).toEqual([
      {
        id: P1,
        name: 'Lamb shoulder, 1 kg',
        sellerName: '',
        category: 'lamb',
        certifications: [],
      },
      { id: P2, name: 'Lamb cutlets', sellerName: '', category: '', certifications: [] },
    ]);
    expect(page?.items.some((card) => 'price' in card)).toBe(false);
  });

  it('matches nothing for a category the tree does not have, without reading products', async () => {
    const { read, paths } = reader({ kind: 'ok', body: PAGE });
    expect(await liveProducts({ category: 'nope', page: 1, pageSize: 12 }, read)).toEqual({
      items: [],
      hasMore: false,
    });
    expect(paths).toEqual(['catalog/categories']);
  });

  it('is undefined with the API off and throws on an outage or a bad body', async () => {
    const off = () => Promise.resolve<ApiRead<unknown>>({ kind: 'off' });
    expect(await liveProducts({ q: 'lamb', page: 1, pageSize: 12 }, off)).toBeUndefined();
    for (const search of [
      { kind: 'failed', status: 500 },
      { kind: 'failed' },
      { kind: 'ok', body: null },
      { kind: 'ok', body: { items: 'x', hasMore: false } },
      { kind: 'ok', body: { items: [], hasMore: 'no' } },
    ] as const) {
      await expect(
        liveProducts({ q: 'lamb', page: 1, pageSize: 12 }, reader(search).read),
      ).rejects.toThrow('product search');
    }
  });
});
