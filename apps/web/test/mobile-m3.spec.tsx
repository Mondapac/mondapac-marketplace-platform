// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import {
  MAX_THROUGH,
  NO_FILTERS,
  throughOf,
  type ListingState,
} from '../src/catalog/listing-state.ts';
import { NumberedPager } from '../src/catalog/listing.tsx';
import type * as Actions from '../src/catalog/load-more.ts';
import { loadMoreProducts } from '../src/catalog/load-more.ts';
import { ListingFilters } from '../src/catalog/listing-controls.tsx';
import { ProductResults, ResultsHead } from '../src/catalog/results.tsx';
import { findProductsThrough } from '../src/catalog/through.ts';
import { HomeSearch } from '../src/home/home-search.tsx';
import { Header } from '../src/shell/header.tsx';
import {
  COLLAPSE_ATTRIBUTE,
  COLLAPSE_SLACK,
  REOPEN_SLACK,
  nextCollapse,
} from '../src/shell/search-collapse.ts';
import { SearchView } from '../src/shell/search-view.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import {
  LISTING_PAGE_SIZE,
  NO_FACETS,
  findProducts,
  type ProductPage,
} from '../src/storefront/catalog.ts';
import type { ShelfCard } from '../src/storefront/types.ts';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../src/catalog/load-more.ts', () => ({ loadMoreProducts: vi.fn() }));

const loadMore = vi.mocked(loadMoreProducts);

beforeEach(() => loadMore.mockReset());
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute(COLLAPSE_ATTRIBUTE);
});

const withIntl = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>{node}</StoreProvider>
    </NextIntlClientProvider>,
  );

const START: ListingState = { filters: NO_FILTERS, sort: 'recommended', page: 1 };

/** Two market fixtures: Australia, and a synthetic market with another currency and locale-less amounts. */
const MARKETS = [
  { name: 'AU', currency: 'AUD' },
  { name: 'synthetic', currency: 'MYR' },
] as const;

const card = (n: number, currency: string): ShelfCard => ({
  id: `item-${n}`,
  name: `Item ${n}`,
  category: 'pantry',
  sellerName: 'Seller',
  certifications: [],
  price: { amount: 1000 + n * 100, currency },
});
const cards = (from: number, count: number, currency: string) =>
  Array.from({ length: count }, (_, i) => card(from + i, currency));

describe('home search collapse logic', () => {
  const base = { collapsed: false, anchor: 0, fieldHeight: 56, maxY: 5000 };

  it('stays open at the top of the page', () => {
    expect(nextCollapse({ ...base, y: 0 })).toEqual({ collapsed: false, anchor: 0 });
    expect(nextCollapse({ ...base, y: 40 })).toEqual({ collapsed: false, anchor: 40 });
  });

  it('collapses after a real run down past the field, not on jitter', () => {
    const jitter = nextCollapse({ ...base, y: 200, anchor: 200 - COLLAPSE_SLACK + 1 });
    expect(jitter.collapsed).toBe(false);
    expect(nextCollapse({ ...base, y: 200, anchor: 200 - COLLAPSE_SLACK }).collapsed).toBe(true);
  });

  it('reopens on a run up and at the top, and stays closed on jitter', () => {
    const closed = { ...base, collapsed: true, anchor: 400 };
    expect(nextCollapse({ ...closed, y: 400 - REOPEN_SLACK + 1 }).collapsed).toBe(true);
    expect(nextCollapse({ ...closed, y: 400 - REOPEN_SLACK }).collapsed).toBe(false);
    expect(nextCollapse({ ...closed, y: 0 }).collapsed).toBe(false);
  });

  it('reopens later than it collapses (12px down, 32px up)', () => {
    expect(COLLAPSE_SLACK).toBe(12);
    expect(REOPEN_SLACK).toBe(32);
  });

  it('ignores iOS bounce above the top and below the end of the page', () => {
    const closed = { ...base, collapsed: true, anchor: 4990, maxY: 5000 };
    // Rubber-band at the bottom: the position goes past the end and back; nothing flips.
    expect(nextCollapse({ ...closed, y: 5040 })).toEqual({ collapsed: true, anchor: 4990 });
    const open = { ...base, collapsed: false, anchor: 4950, maxY: 5000 };
    expect(nextCollapse({ ...open, y: 5060 })).toEqual({ collapsed: false, anchor: 4950 });
    // Rubber-band at the top.
    expect(nextCollapse({ ...closed, y: -30 })).toEqual({ collapsed: true, anchor: 4990 });
  });
});

describe('phone home search field', () => {
  const scrollTo = (y: number) => {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
  };
  const root = document.documentElement;

  it('is a button that opens the existing search view', () => {
    withIntl(
      <>
        <HomeSearch />
        <SearchView popular={[]} />
      </>,
    );
    const field = screen.getByRole('button', { name: 'Search products, stores' });
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog.hasAttribute('hidden')).toBe(true);
    fireEvent.click(field);
    expect(dialog.hasAttribute('hidden')).toBe(false);
  });

  it('toggles the collapsed state on scroll down and up, and clears it on leaving', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 5000,
      configurable: true,
    });
    scrollTo(0);
    const { unmount } = withIntl(<HomeSearch />);
    scrollTo(300);
    expect(root.getAttribute(COLLAPSE_ATTRIBUTE)).toBe('collapsed');
    scrollTo(330);
    expect(root.getAttribute(COLLAPSE_ATTRIBUTE)).toBe('collapsed');
    scrollTo(300);
    // 30px up is under the reopen distance.
    expect(root.getAttribute(COLLAPSE_ATTRIBUTE)).toBe('collapsed');
    scrollTo(290);
    expect(root.getAttribute(COLLAPSE_ATTRIBUTE)).toBeNull();
    scrollTo(400);
    expect(root.getAttribute(COLLAPSE_ATTRIBUTE)).toBe('collapsed');
    unmount();
    expect(root.getAttribute(COLLAPSE_ATTRIBUTE)).toBeNull();
    scrollTo(0);
  });

  it('adds no search icon to the header (the tab bar has Search)', () => {
    const { container } = withIntl(<Header delivery={{ label: 'Brisbane 4000' }} />);
    expect(container.querySelector('.hs-icon')).toBeNull();
  });
});

describe('listing address and server side', () => {
  it('reads ?through only when it is after the page and within the cap', () => {
    expect(throughOf({}, 1)).toBe(1);
    expect(throughOf({ through: '3' }, 1)).toBe(3);
    expect(throughOf({ through: '3' }, 3)).toBe(3);
    expect(throughOf({ through: '2' }, 4)).toBe(4);
    expect(throughOf({ through: '99' }, 1)).toBe(1);
    // The limit is an absolute page number.
    expect(throughOf({ through: String(MAX_THROUGH) }, 1)).toBe(MAX_THROUGH);
    expect(throughOf({ through: String(MAX_THROUGH + 1) }, 5)).toBe(5);
    expect(throughOf({ through: 'x' }, 1)).toBe(1);
  });

  it('lists pages 1 to N as one list with the last page flags', async () => {
    const scope = { category: 'pantry', pageSize: LISTING_PAGE_SIZE };
    const one = await findProducts({ ...scope, page: 1 });
    const two = await findProducts({ ...scope, page: 2 });
    const both = await findProductsThrough({ ...scope, page: 1 }, 2);
    expect(both.items.map((p) => p.id)).toEqual([...one.items, ...two.items].map((p) => p.id));
    expect(both.hasMore).toBe(false);
    expect(both.total).toBe(one.total);
  });

  it('refuses a malformed Load more request and gives page 2 for a good one', async () => {
    const real = await vi.importActual<typeof Actions>('../src/catalog/load-more.ts');
    expect(await real.loadMoreProducts('x')).toBeNull();
    expect(
      await real.loadMoreProducts({ scope: { category: '../x' }, query: '', page: 2 }),
    ).toBeNull();
    expect(await real.loadMoreProducts({ scope: {}, query: '', page: 1 })).toBeNull();
    const page = await real.loadMoreProducts({ scope: { category: 'pantry' }, query: '', page: 2 });
    expect(page?.page).toBe(2);
    expect(page?.items.length).toBeGreaterThan(0);
  });
});

describe.each(MARKETS)('Load more in the $name market', ({ currency }) => {
  const first = cards(1, LISTING_PAGE_SIZE, currency);
  const result = (over: Partial<ProductPage> = {}): ProductPage => ({
    items: first,
    page: 1,
    pageSize: LISTING_PAGE_SIZE,
    hasMore: true,
    total: 30,
    ...over,
  });
  const renderResults = (over: Partial<ProductPage> = {}) =>
    withIntl(
      <ProductResults
        result={result(over)}
        hrefFor={(page) => `/c/pantry?page=${page}`}
        empty={<p>empty</p>}
        loadMore={{ scope: { category: 'pantry' }, state: START, path: '/c/pantry', through: 1 }}
        pager={<NumberedPager path="/c/pantry" state={START} pages={3} />}
      />,
    );

  it('shows prices in the data currency, Showing X of Y, and a 44px-class button', () => {
    renderResults();
    const money = new Intl.NumberFormat('en', { style: 'currency', currency })
      .format(11)
      .replace(/\s/gu, ' ');
    expect(screen.getByText(money)).toBeTruthy();
    expect(screen.getByText('Showing 12 of 30')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' }).className).toContain('lm-btn');
    // The pager links stay in the markup: they are the way on without a script.
    const pager = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pager).getByRole('link', { name: 'Page 2' }).getAttribute('href')).toBe(
      '/c/pantry?page=2',
    );
    expect(screen.getByText('Showing 12 of 30').closest('.lm-wrap')?.getAttribute('data-lm')).toBe(
      'on',
    );
  });

  it('appends the next page, updates the address, moves focus and announces the count', async () => {
    loadMore.mockResolvedValue(
      result({ items: cards(13, LISTING_PAGE_SIZE, currency), page: 2, hasMore: true }),
    );
    const replace = vi.spyOn(window.history, 'replaceState');
    window.history.replaceState(null, '', '/c/pantry?sort=name');
    replace.mockClear();
    renderResults();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(24));
    expect(loadMore).toHaveBeenCalledWith({
      scope: { category: 'pantry' },
      query: '',
      page: 2,
    });
    // Same list, replaceState (no history entry), `through` names the last page loaded.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[2]).toBe('/c/pantry?sort=name&through=2');
    // Focus lands on the first new product's link.
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Item 13'));
    expect(screen.getByText('Showing 24 of 30')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      '12 more products loaded. Showing 24 of 30.',
    );
    replace.mockRestore();
  });

  it('removes the button when the last page is in and keeps the count', async () => {
    loadMore.mockResolvedValue(
      result({ items: cards(13, 6, currency), page: 2, hasMore: false, total: 18 }),
    );
    renderResults({ total: 18 });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(18));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByText('Showing 18 of 18')).toBeTruthy();
  });

  it('says so, and keeps the button, when the page cannot be loaded', async () => {
    // The action answers null for a request it refuses; the same path as a failed call.
    loadMore.mockResolvedValue(null);
    renderResults();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'We could not load more products. Try again.',
    );
    expect(screen.getAllByRole('article')).toHaveLength(12);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('counts products when the source gives no total', () => {
    renderResults({ total: undefined as unknown as number });
    expect(screen.getByText('Showing 12 products')).toBeTruthy();
  });
});

describe('Load more limit', () => {
  it('offers a Next page link instead of the button at the last allowed page', async () => {
    loadMore.mockResolvedValue({
      items: cards(100, 12, 'AUD'),
      page: MAX_THROUGH,
      pageSize: 12,
      hasMore: true,
      total: 200,
    });
    const replace = vi.spyOn(window.history, 'replaceState');
    window.history.replaceState(null, '', '/c/pantry');
    replace.mockClear();
    withIntl(
      <ProductResults
        result={{ items: cards(1, 12, 'AUD'), page: 1, pageSize: 12, hasMore: true, total: 200 }}
        hrefFor={(page) => `/c/pantry?page=${page}`}
        empty={<p>empty</p>}
        loadMore={{
          scope: { category: 'pantry' },
          state: START,
          path: '/c/pantry',
          through: MAX_THROUGH - 1,
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    const next = await screen.findByRole('link', { name: 'Next page' });
    expect(next.getAttribute('href')).toBe(`/c/pantry?page=${MAX_THROUGH + 1}`);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    // through reached the limit and was written once; never beyond it.
    expect(replace.mock.calls.map((c) => c[2])).toEqual([`/c/pantry?through=${MAX_THROUGH}`]);
    replace.mockRestore();
  });
});

describe('phone listing bar and title', () => {
  it('puts Filters and the compact Sort before the quick chips', () => {
    withIntl(
      <ListingFilters
        path="/c/pantry"
        state={START}
        facets={{ ...NO_FACETS, certifications: [{ id: 'halal', name: 'Halal', count: 3 }] }}
        total={14}
      />,
    );
    const bar = screen.getByRole('group', { name: 'Quick filters' });
    const order = [...bar.querySelectorAll('button, select')].map((el) =>
      el.tagName === 'SELECT' ? 'SELECT' : el.textContent?.trim(),
    );
    expect(order.slice(0, 2)).toEqual(['All filters', 'SELECT']);
    expect(order).toContain('Halal');
    // The sort keeps its name for screen readers, and shows "Sort:" next to the choice.
    expect(within(bar).getByRole('combobox', { name: 'Sort by' })).toBeTruthy();
    expect(bar.textContent).toContain('Sort:');
  });

  it('shows the total next to the title, and nothing when there is none', () => {
    const { unmount } = withIntl(<ResultsHead title="Pantry" total={86} />);
    expect(screen.getByText('86 products')).toBeTruthy();
    unmount();
    withIntl(<ResultsHead title="Pantry" />);
    expect(screen.queryByText(/products/)).toBeNull();
  });
});

describe('desktop listing', () => {
  it('still renders the numbered pager with ?page= links (no Load more without the prop)', () => {
    withIntl(
      <ProductResults
        result={{
          items: cards(1, 12, 'AUD'),
          page: 2,
          pageSize: 12,
          hasMore: true,
          total: 40,
        }}
        hrefFor={(page) => `/c/pantry?page=${page}`}
        empty={<p>empty</p>}
        pager={<NumberedPager path="/c/pantry" state={{ ...START, page: 2 }} pages={4} />}
      />,
    );
    const pager = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pager).getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe(
      '/c/pantry?page=3',
    );
    expect(within(pager).getByRole('link', { name: 'Previous page' }).getAttribute('href')).toBe(
      '/c/pantry',
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
