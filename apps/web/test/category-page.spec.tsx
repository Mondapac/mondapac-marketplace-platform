import { NextIntlClientProvider, createTranslator } from 'next-intl';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { StoreProvider } from '../src/shell/store-context.tsx';
import type { ApiRead } from '../src/storefront/api.ts';

// The category page on the live tree (categories C6): filter chips of the children shown with
// their counts and "Other {name}" on a level-3 category, the short description, the deep crumbs,
// the "Other" view (`?direct=1`) and the empty category, with the API answering from a stub.

const api = vi.hoisted(() => ({ paths: [] as string[], items: [] as unknown[] }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'shop.example' })),
  cookies: () => Promise.resolve({ get: () => undefined }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(createTranslator({ locale: 'en', messages, namespace: namespace as 'store' })),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
}));
// Indexing on, so a page's own noindex is what the metadata shows.
vi.mock('../src/storefront/source.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  SAMPLE_DATA: false,
}));
vi.mock('../src/storefront/config.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  storefrontApiConfig: () => ({
    apiBaseUrl: 'https://api.shop.example',
    hosts: [{ origin: 'https://shop.example', host: 'shop.example', marketId: 'AU' }],
    clientAddressKey: null,
  }),
}));

const id = (n: number) => `0b5e1c3a-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const row = (n: number, parent: number | null, slug: string, name: string, extra = {}) => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  slug,
  name,
  inMenu: true,
  hasLiveProducts: true,
  ...extra,
});
const TREE = {
  categories: [
    row(1, null, 'meat', 'Meat', { liveProductCount: 9 }),
    row(2, 1, 'lamb', 'Lamb', { liveProductCount: 9 }),
    row(3, 2, 'lamb-chops', 'Lamb chops', {
      liveProductCount: 5,
      shortDescription: 'Loin and rib, cut to order',
    }),
    row(4, 3, 'loin', 'Loin', { liveProductCount: 2 }),
    row(5, 3, 'rib', 'Rib', { liveProductCount: 0, hasLiveProducts: false, inMenu: false }),
    row(6, 2, 'goat', 'Goat', { liveProductCount: 0, hasLiveProducts: false, inMenu: false }),
  ],
};

vi.mock('../src/storefront/api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiGet: (path: string): Promise<ApiRead<unknown>> => {
    api.paths.push(path);
    if (path.startsWith('catalog/categories')) return Promise.resolve({ kind: 'ok', body: TREE });
    return Promise.resolve({ kind: 'ok', body: { items: api.items, hasMore: false } });
  },
}));

const { default: CategoryPage, generateMetadata } = await import('../app/c/[slug]/page.tsx');

const props = (slug: string, query: Record<string, string> = {}) => ({
  params: Promise.resolve({ slug }),
  searchParams: Promise.resolve(query),
});
const html = async (slug: string, query: Record<string, string> = {}) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>{(await CategoryPage(props(slug, query))) as ReactElement}</StoreProvider>
    </NextIntlClientProvider>,
  );
const chipsOf = (page: string) => /<nav class="fchips"[\s\S]*?<\/nav>/u.exec(page)?.[0] ?? '';
const ITEM = {
  offerId: id(90),
  productId: id(91),
  sellerId: id(92),
  name: 'Lamb loin chops',
  shortText: null,
  categoryIds: [id(4)],
};

beforeEach(() => {
  vi.stubEnv('STOREFRONT_INDEXING', 'on');
  api.paths.length = 0;
  api.items = [ITEM];
});

describe('category page on the live tree', () => {
  it('offers the children shown with their counts and "Other {name}" with its own', async () => {
    const page = await html('lamb-chops');
    const chips = chipsOf(page);

    expect(chips).toContain('href="/c/loin"');
    expect(chips).toMatch(/Loin<span class="cnt num" aria-hidden="true">2<\/span>/u);
    expect(chips).toContain('<span class="sr-only">, 2 products</span>');
    // Rib is out of the menu (no live products): no chip leads to an empty list.
    expect(chips).not.toContain('/c/rib');
    // 5 on the category, 2 of them below it: 3 directly on it.
    expect(chips).toMatch(/href="\/c\/lamb-chops\?direct=1"[^>]*>Other Lamb chops<span[^>]*>3</u);
    expect(page).toContain('<p class="cdesc" dir="auto">Loin and rib, cut to order</p>');
  });

  it('gives no "Other" chip above level 3, and none on a category with nothing directly on it', async () => {
    expect(chipsOf(await html('lamb'))).not.toContain('direct=1');
    expect(chipsOf(await html('lamb'))).toContain('href="/c/lamb-chops"');
    // Meat is level 1: its only child chip, no "Other".
    expect(chipsOf(await html('meat'))).not.toContain('Other');
  });

  it('lists only the products directly on the category in its "Other" view, out of the index', async () => {
    const page = await html('lamb-chops', { direct: '1' });

    expect(api.paths.at(-1)).toBe(
      `search/products?category=${id(3)}&direct=true&page=1&pageSize=12`,
    );
    expect(chipsOf(page)).toMatch(/aria-current="page" href="\/c\/lamb-chops\?direct=1"/u);
    expect(page).not.toContain('application/ld+json');
    const meta = await generateMetadata(props('lamb-chops', { direct: '1' }));
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates?.canonical).toBe('https://shop.example/c/lamb-chops');
  });

  it('ignores `direct` on a category that has no "Other" chip', async () => {
    await html('meat', { direct: '1' });
    expect(api.paths.at(-1)).not.toContain('direct');
    expect((await generateMetadata(props('meat', { direct: '1' }))).robots).toBeUndefined();
  });

  it('says what is empty in the "Other" view and links back to the whole category', async () => {
    api.items = [];
    const page = await html('lamb-chops', { direct: '1' });

    expect(page).toContain('There are no products in Other Lamb chops yet. Check back soon.');
    expect(page).toMatch(/<a class="btn" href="\/c\/lamb-chops">See all Lamb chops<\/a>/u);
  });

  it('keeps an empty category out of the index with its message and a link to its parent', async () => {
    api.items = [];
    const page = await html('goat');
    const meta = await generateMetadata(props('goat'));

    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(page).toContain('There are no products in Goat yet. Check back soon.');
    expect(page).toMatch(/<a class="btn" href="\/c\/lamb">See all Lamb<\/a>/u);
    expect(page).not.toContain('application/ld+json');
  });

  it('gives a level-4 page the whole trail as crumbs and structured data, and no chips', async () => {
    const page = await html('loin');
    const data = JSON.parse(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(page)![1]!,
    ) as { '@graph': { itemListElement?: { position: number; name: string }[] }[] };

    expect(chipsOf(page)).toBe('');
    expect(data['@graph'][1]!.itemListElement!.map((c) => [c.position, c.name])).toEqual([
      [1, 'Home'],
      [2, 'Meat'],
      [3, 'Lamb'],
      [4, 'Lamb chops'],
      [5, 'Loin'],
    ]);
  });
});
