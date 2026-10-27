// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { NO_FILTERS, type ListingState } from '../src/catalog/listing-state.ts';
import { LiveSearchResults } from '../src/search/search-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import type { ApiRead } from '../src/storefront/api.ts';
import {
  NO_FACETS,
  findProducts,
  findStores,
  listingBanner,
  listingFacets,
  listingIsLive,
  resolveCategory,
  searchCategories,
  searchCategory,
} from '../src/storefront/catalog.ts';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';
import type * as CategoryTree from '../src/storefront/category-tree.ts';
import type { ShelfCard } from '../src/storefront/types.ts';

// The category and search pages' reads with the API on, through catalog.ts: what is read, what
// is answered from the route and what is left empty rather than taken from the sample.

const MEAT = '0b5e1c3a-0000-4000-8000-000000000001';
const reads = vi.hoisted(() => ({ paths: [] as string[], config: true }));

vi.mock('../src/storefront/config.ts', () => ({
  storefrontApiConfig: () => (reads.config ? {} : null),
}));
vi.mock('../src/storefront/category-tree.ts', async (original) => ({
  ...(await original<typeof CategoryTree>()),
  readOnce: (path: string): Promise<ApiRead<unknown>> => {
    reads.paths.push(path);
    if (!reads.config) return Promise.resolve({ kind: 'off' });
    return Promise.resolve({
      kind: 'ok',
      body: path.startsWith('catalog/')
        ? {
            categories: [
              { id: MEAT, parentId: null, slug: 'meat', name: 'Meat', depth: 0, position: 0 },
            ],
          }
        : {
            items: [
              {
                offerId: MEAT,
                productId: '0b5e1c3a-0000-4000-8000-0000000000c1',
                sellerId: MEAT,
                name: 'Lamb shoulder, 1 kg',
                shortText: null,
                categoryIds: [MEAT],
              },
            ],
            hasMore: true,
          },
    });
  },
}));

beforeEach(() => {
  reads.paths = [];
  reads.config = true;
});
afterEach(cleanup);

const START: ListingState = { filters: NO_FILTERS, sort: 'recommended', page: 1 };

describe('catalog reads with the API on', () => {
  it('lists the route page, with hasMore and no total', async () => {
    const result = await findProducts({
      category: 'meat',
      page: 3,
      pageSize: 12,
      sort: 'price-asc',
    });
    expect(reads.paths).toEqual([
      'catalog/categories',
      `search/products?category=${MEAT}&page=3&pageSize=12`,
    ]);
    expect(result).toMatchObject({ page: 3, pageSize: 12, hasMore: true });
    expect(result.total).toBeUndefined();
    expect(result.items.map((p) => p.name)).toEqual(['Lamb shoulder, 1 kg']);
  });

  it('matches nothing for a filter the route cannot apply, without reading it', async () => {
    const result = await findProducts({
      q: 'lamb',
      page: 1,
      filters: { ...NO_FILTERS, special: true },
    });
    expect(result.items).toEqual([]);
    expect(reads.paths).toEqual([]);
  });

  it('leaves out facets, banners, category counts and stores instead of sampling them', async () => {
    expect(listingIsLive()).toBe(true);
    expect(await listingFacets({ category: 'meat' })).toBe(NO_FACETS);
    expect(await listingBanner('meat')).toBeUndefined();
    expect(await searchCategories('lamb')).toEqual([]);
    expect((await findStores('lamb')).items).toEqual([]);
    expect(reads.paths).toEqual([]);
  });

  it('resolves a category from the live tree, so a sample code is a 404', async () => {
    expect((await resolveCategory('meat'))?.category.name).toBe('Meat');
    expect(await resolveCategory('poultry')).toBeUndefined();
  });

  it('keeps an unknown search category so the search finds nothing there', async () => {
    expect(await searchCategory('meat')).toMatchObject({ code: 'meat', name: 'Meat' });
    const stale = await searchCategory('poultry');
    expect(stale).toEqual({ code: 'poultry', name: 'poultry', shortName: 'poultry', children: [] });
    reads.paths = [];
    const result = await findProducts({ q: 'lamb', category: 'poultry', page: 1, pageSize: 12 });
    expect(result.items).toEqual([]);
    expect(reads.paths).toEqual(['catalog/categories']);
    expect(await searchCategory(undefined)).toBeUndefined();
  });

  it('answers the sample with the API off', async () => {
    reads.config = false;
    expect(listingIsLive()).toBe(false);
    expect((await resolveCategory('poultry'))?.category.code).toBe('poultry');
    expect((await resolveCategory('meat', 'lamb'))?.child?.code).toBe('lamb');
    expect(await resolveCategory('meat', 'nope')).toBeUndefined();
    expect(await searchCategory('nope')).toBeUndefined();
    expect((await findProducts({ category: 'meat', page: 1 })).total).toBe(5);
    expect((await findProducts({ category: 'meat', page: 1 })).items[0]?.price).toBeDefined();
  });
});

const CARD: ShelfCard = {
  id: 'p1',
  name: 'Lamb shoulder, 1 kg',
  sellerName: '',
  category: 'meat',
  certifications: [],
};

function show(
  items: readonly ShelfCard[],
  extra: Partial<Parameters<typeof LiveSearchResults>[0]> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>
        <LiveSearchResults
          query="lamb"
          categories={SAMPLE_CONTENT.categories}
          state={START}
          products={{ items, page: 1, pageSize: 12, hasMore: true }}
          facets={NO_FACETS}
          popular={[]}
          {...extra}
        />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

describe('live search results', () => {
  it('shows priceless cards with a next link and no counts, tabs or filter controls', () => {
    const { container } = show([CARD]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('lamb');
    expect(screen.getByRole('link', { name: 'Lamb shoulder, 1 kg' })).toBeTruthy();
    expect(container.querySelector('.pr, .gst, .by, button:not(.lm-btn)')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText(/products ·/)).toBeNull();
    expect(screen.queryByText('Filter by:')).toBeNull();
    expect(screen.getByRole('link', { name: /next/i }).getAttribute('href')).toBe(
      '/search?q=lamb&page=2',
    );
  });

  it('says nothing was found in a category, with a way to search everywhere', () => {
    show([], {
      category: { code: 'poultry', name: 'poultry', shortName: 'poultry', children: [] },
      products: { items: [], page: 1, pageSize: 12, hasMore: false },
    });
    expect(screen.getByRole('status').textContent).toContain('poultry');
    expect(screen.getByRole('link', { name: 'Search all categories' }).getAttribute('href')).toBe(
      '/search?q=lamb',
    );
  });

  it('says nothing was found, and when a filter in the URL is the reason', () => {
    show([], { products: { items: [], page: 1, pageSize: 12, hasMore: false } });
    expect(screen.getByRole('heading', { name: /No results/i })).toBeTruthy();
    cleanup();
    show([], {
      state: { ...START, filters: { ...NO_FILTERS, special: true } },
      products: { items: [], page: 1, pageSize: 12, hasMore: false },
    });
    expect(screen.getByRole('link', { name: 'Clear all filters' }).getAttribute('href')).toBe(
      '/search?q=lamb',
    );
  });
});
